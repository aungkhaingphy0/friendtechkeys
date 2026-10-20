// Everything that talks to Base, Blockscout or the wallet. No DOM access here.
import { ABI, CHAIN, KEYS, MULTICALL, MULTICALL_CHUNK, SCAN_PAGES, SELECTORS } from "./config.js";

const { ethers } = window;
const keysIface = new ethers.Interface(ABI);
const multicallIface = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
]);
// batchMaxCount 1: send each request on its own, so a burst of reads can't trip a per-request rate limit at once.
const providers = CHAIN.readRpcs.map((url) => new ethers.JsonRpcProvider(url, CHAIN.id, { staticNetwork: true, batchMaxCount: 1 }));
let preferred = 0; // index of the last endpoint that answered

const min = (a, b) => (a < b ? a : b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- RPC with retries ----------

/**
 * Runs `fn(provider)` on a public endpoint, moving to the next one with a growing delay when it fails.
 * Only used for calls that can't revert on their own (plain reads and Multicall3 with allowFailure),
 * so any error here is the endpoint's fault: rate limit, outage or network.
 */
async function withRpc(fn, attempts = 8) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const index = (preferred + i) % providers.length;
    try {
      const result = await fn(providers[index]);
      preferred = index;
      return result;
    } catch (e) {
      lastError = e;
      await sleep(Math.min(300 * 2 ** i, 4000));
    }
  }
  throw new Error(`Base RPC is busy right now (${lastError?.shortMessage || lastError?.message || lastError}). Try again in a minute.`);
}

/**
 * Batched contract reads through Multicall3. `calls` is [[functionName, args], ...] on the keys contract.
 * Returns each decoded result, or null for a call that reverted.
 */
async function readMany(calls) {
  const results = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const chunk = calls.slice(i, i + MULTICALL_CHUNK);
    const data = multicallIface.encodeFunctionData("aggregate3", [
      chunk.map(([fn, args]) => ({ target: KEYS, allowFailure: true, callData: keysIface.encodeFunctionData(fn, args) })),
    ]);
    const raw = await withRpc((p) => p.call({ to: MULTICALL, data }));
    const [rows] = multicallIface.decodeFunctionResult("aggregate3", raw);
    rows.forEach(([success, returnData], j) => {
      results.push(success ? keysIface.decodeFunctionResult(chunk[j][0], returnData)[0] : null);
    });
  }
  return results;
}

function toPosition(subject, supply, balance) {
  if (supply == null) throw new Error("Couldn't read this account from the key contract.");
  const sellable = supply > 0n ? supply - 1n : 0n;
  return { subject, supply, balance, max: balance == null ? 0n : min(balance, sellable) };
}

// ---------- Reads ----------

/** Holder's position in a subject's keys. `max` is what can be sold: the contract never sells the last key. */
export async function readPosition(subject, holder) {
  const [supply, balance] = await readMany([
    ["sharesSupply", [subject]],
    ...(holder ? [["sharesBalance", [subject, holder]]] : []),
  ]);
  return toPosition(subject, supply, holder ? balance : null);
}

export async function quote(subject, amount) {
  const [gross, net] = await readMany([
    ["getSellPrice", [subject, amount]],
    ["getSellPriceAfterFee", [subject, amount]],
  ]);
  if (gross == null || net == null) throw new Error("Couldn't get a price for this amount.");
  return { gross, net, fee: gross - net };
}

export const ethBalance = (address) => withRpc((p) => p.getBalance(address));

/** fetch() that waits out rate limits (honouring Retry-After), server errors and network failures. */
async function fetchRetry(url, attempts = 8) {
  for (let i = 1; ; i++) {
    let wait = Math.min(1000 * 2 ** (i - 1), 10000);
    try {
      const r = await fetch(url);
      if (r.status !== 429 && r.status < 500) return r;
      if (i >= attempts) throw new Error(`The block explorer is busy right now (HTTP ${r.status}). Try again in a minute.`);
      const retryAfter = Number(r.headers.get("retry-after"));
      if (retryAfter > 0) wait = Math.min(retryAfter * 1000, 30000);
    } catch (e) {
      if (i >= attempts) throw e;
    }
    await sleep(wait);
  }
}

/**
 * Every subject the holder bought or sold (plus themself), from the holder's sent transactions on Blockscout.
 * Keys can't be transferred, so every key a wallet holds came from a buyShares call that wallet sent.
 * `partial` is true when the history was longer than SCAN_PAGES.
 */
async function tradedSubjects(holder, onProgress) {
  const subjects = new Set([holder.toLowerCase()]);
  const keys = KEYS.toLowerCase();
  let cursor = "";
  for (let page = 1; page <= SCAN_PAGES; page++) {
    onProgress?.(`Reading wallet history · page ${page}`);
    const r = await fetchRetry(`${CHAIN.blockscout}/api/v2/addresses/${holder}/transactions?filter=from${cursor}`);
    if (r.status === 404) break; // address never seen on Base
    if (!r.ok) throw new Error(`explorer returned HTTP ${r.status}`);
    const j = await r.json();
    for (const t of j.items ?? []) {
      const input = (t.raw_input ?? "").toLowerCase();
      const sel = input.slice(0, 10);
      if (t.to?.hash?.toLowerCase() === keys && input.length >= 74 && (sel === SELECTORS.buy || sel === SELECTORS.sell)) {
        subjects.add("0x" + input.slice(34, 74));
      }
    }
    if (!j.next_page_params) return { subjects: [...subjects].map((s) => ethers.getAddress(s)), partial: false };
    const params = Object.entries(j.next_page_params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
    cursor = "&" + new URLSearchParams(params).toString();
  }
  return { subjects: [...subjects].map((s) => ethers.getAddress(s)), partial: cursor !== "" };
}

/**
 * Positions the holder still has, each with `value` = ETH for selling everything sellable, highest first.
 * Returns { holdings, partial }.
 */
export async function findHoldings(holder, onProgress) {
  const { subjects, partial } = await tradedSubjects(holder, onProgress);
  onProgress?.(`Checking ${subjects.length} ${subjects.length === 1 ? "account" : "accounts"}`);
  const reads = await readMany(subjects.flatMap((s) => [["sharesSupply", [s]], ["sharesBalance", [s, holder]]]));
  const held = subjects
    .map((s, i) => ({ subject: s, supply: reads[2 * i], balance: reads[2 * i + 1] }))
    .filter((p) => p.supply != null && p.balance > 0n)
    .map((p) => toPosition(p.subject, p.supply, p.balance));

  const priced = held.filter((p) => p.max > 0n);
  onProgress?.(`Pricing ${priced.length} ${priced.length === 1 ? "position" : "positions"}`);
  const values = await readMany(priced.map((p) => ["getSellPriceAfterFee", [p.subject, p.max]]));
  for (const p of held) p.value = 0n;
  priced.forEach((p, i) => { p.value = values[i] ?? 0n; });
  return { holdings: held.sort(byValue), partial };
}

/** Sort order for holdings: most ETH first, then most keys. */
export function byValue(a, b) {
  if (a.value !== b.value) return b.value > a.value ? 1 : -1;
  return b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0;
}

// ---------- Wallet ----------

const injected = () => window.ethereum;
export const hasWallet = () => Boolean(injected());

const toAccount = (list) => (list?.[0] ? ethers.getAddress(list[0]) : null);

export const currentAccount = async () => toAccount(await injected().request({ method: "eth_accounts" }));
export const requestAccount = async () => toAccount(await injected().request({ method: "eth_requestAccounts" }));
export const walletChainId = async () => Number(await injected().request({ method: "eth_chainId" }));

export function onWalletChange({ account, chain }) {
  injected()?.on?.("accountsChanged", (list) => account(toAccount(list)));
  injected()?.on?.("chainChanged", (id) => chain(Number(id)));
}

export async function switchToBase() {
  try {
    await injected().request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] });
  } catch (e) {
    if (e?.code !== 4902) throw e; // 4902: chain not added to the wallet yet
    await injected().request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN.hex,
        chainName: CHAIN.name,
        rpcUrls: [CHAIN.rpc],
        blockExplorerUrls: [CHAIN.explorer],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      }],
    });
  }
}

/** The wallet's signer for `account`, after switching the wallet to Base. */
async function baseSigner(account) {
  if ((await walletChainId()) !== CHAIN.id) await switchToBase();
  const signer = await new ethers.BrowserProvider(injected()).getSigner();
  if (ethers.getAddress(signer.address) !== account) throw new Error("Your wallet switched accounts. Reconnect and try again.");
  return signer;
}

/**
 * Sells `amount` keys of `subject` from `account`. Reports progress through `onPhase`:
 * "check" (switch network + simulate), "sign" (waiting for the wallet), "pending" (sent, with hash).
 */
export async function sellKeys({ subject, amount, account, onPhase }) {
  onPhase("check");
  const keys = new ethers.Contract(KEYS, ABI, await baseSigner(account));
  await keys.sellShares.staticCall(subject, amount);

  onPhase("sign");
  const tx = await keys.sellShares(subject, amount);

  onPhase("pending", tx.hash);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("The transaction failed on-chain.");
  return tx.hash;
}

export const isUserRejection = (e) => e?.code === "ACTION_REJECTED" || e?.code === 4001 || e?.info?.error?.code === 4001;

export function friendlyError(e) {
  if (isUserRejection(e)) return "You cancelled it in your wallet.";
  const reason = e?.reason || e?.shortMessage || e?.message || String(e);
  if (/last share/i.test(reason)) return "That would sell this person's last key, which the contract never allows.";
  if (/insufficient shares/i.test(reason)) return "You don't hold that many of this person's keys.";
  if (/insufficient funds/i.test(reason)) return "Not enough ETH on Base to pay the gas.";
  return reason;
}

// ---------- Formatting ----------

export const isAddress = (s) => ethers.isAddress(s);
export const checksum = (s) => ethers.getAddress(s);

export function formatEth(wei) {
  const n = Number(ethers.formatEther(wei));
  if (n === 0) return "0";
  return n.toLocaleString(undefined, n < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 4 });
}
