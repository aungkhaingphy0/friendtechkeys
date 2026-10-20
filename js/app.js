// UI: one state object, render functions that draw it, and event handlers that change it.
import { CHAIN, KEYS, TIP_ADDRESS } from "./config.js";
import * as chain from "./chain.js";

const $ = (id) => document.getElementById(id);
const PHASES = ["check", "sign", "pending"];
const PHASE_TEXT = { check: "Checking the sale…", sign: "Confirm in your wallet…", pending: "Confirming on Base…" };
const ROW_STATUS = { waiting: "Waiting", active: "Selling", sold: "Sold", failed: "Failed", skipped: "Skipped" };
const THEMES = ["system", "light", "dark"];
const THEME_KEY = "keys-sell:theme";
const IDLE_SALE = { phase: "idle", hash: null, error: null, sold: null }; // phase: idle | check | sign | pending | done | error

const state = {
  account: null, // connected wallet
  chainId: null,
  ethBalance: null,
  viewer: null, // wallet whose keys are listed: the searched one, or the connected one
  scan: { status: "idle", holdings: [], partial: false, error: null }, // idle | loading | done | error
  position: null, // { subject, supply, balance, max } of `viewer`; supply/balance are null while loading
  amount: 1n,
  quote: null, // { gross, net, fee }
  quoteLoading: false,
  sale: IDLE_SALE,
  batch: null, // "Sell all": { phase: confirm | running | done, items, index, step, stop, error }
};

let selectSeq = 0;
let quoteSeq = 0;

// ---------- Helpers ----------

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const plural = (n, word) => `${n} ${word}${n === 1n || n === 1 ? "" : "s"}`;
const people = (n) => (n === 1 ? "1 person" : `${n} people`);
const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
const busy = () => PHASES.includes(state.sale.phase);
const batchActive = () => Boolean(state.batch) && state.batch.phase !== "done";
const canSell = () => same(state.account, state.viewer);
const holder = () => state.viewer ?? state.account;
const sellable = () => state.scan.holdings.filter((h) => h.max > 0n);
const sumValue = (list) => list.reduce((sum, h) => sum + (h.value ?? 0n), 0n);

function paintAvatar(node, address) {
  const h1 = parseInt(address.slice(2, 6), 16) % 360;
  const h2 = (h1 + 40 + (parseInt(address.slice(6, 8), 16) % 100)) % 360;
  node.style.setProperty("--h1", h1);
  node.style.setProperty("--h2", h2);
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Address copied"); } catch { /* clipboard blocked */ }
}

function setText(id, text) { $(id).textContent = text; }
function show(id, visible) { $(id).hidden = !visible; }

function setUrlParam(key, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  history.replaceState(null, "", url);
}

// ---------- Theme ----------

const currentTheme = () => document.documentElement.getAttribute("data-theme") ?? "system";
const nextTheme = () => THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];

function renderTheme() {
  $("themeBtn").setAttribute("aria-label", `Theme: ${currentTheme()}. Switch to ${nextTheme()}.`);
  $("themeBtn").title = `Theme: ${currentTheme()}`;
}

function cycleTheme() {
  const next = nextTheme();
  if (next === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  renderTheme();
}

// ---------- Render: wallet chip ----------

function renderWallet() {
  const btn = $("walletBtn");
  const wrongNetwork = state.account && state.chainId != null && state.chainId !== CHAIN.id;
  btn.dataset.state = !state.account ? "disconnected" : wrongNetwork ? "wrong-network" : "connected";
  setText("walletLabel", !state.account ? "Connect wallet" : wrongNetwork ? "Switch to Base" : short(state.account));
  btn.title = state.account && !wrongNetwork ? "Copy address" : "";
  show("walletEth", state.account && state.ethBalance != null);
  if (state.ethBalance != null) setText("walletEth", `${chain.formatEth(state.ethBalance)} ETH`);
}

// ---------- Render: keys card ----------

function renderKeys() {
  const { viewer, account } = state;
  const { status, holdings, partial, error } = state.scan;
  const mine = same(viewer, account);

  setText("keysTitle", !viewer || mine ? "Your keys" : "Keys held by");
  show("viewerTag", Boolean(viewer));
  if (viewer) {
    paintAvatar($("viewerAvatar"), viewer);
    setText("viewerAddr", short(viewer));
    $("viewerAddr").title = viewer;
    show("viewerYou", mine);
  }

  // Who can sell what
  show("viewerNote", Boolean(viewer) && !mine);
  if (viewer && !mine) {
    setText("viewerNoteText", !account
      ? "To sell these keys, connect this wallet."
      : `You're connected as ${short(account)}. To sell these keys, switch your wallet to ${short(viewer)}.`);
    show("viewMineBtn", Boolean(account));
  }

  // Empty / loading / result
  show("keysConnect", !viewer);
  if (!viewer && !chain.hasWallet()) {
    setText("keysConnectText", "No wallet found in this browser. You can still paste any wallet address above to see its keys. To sell, install MetaMask, Rabby or Coinbase Wallet and reload.");
    show("connectBtn", false);
  }
  show("keysLoading", Boolean(viewer) && status === "loading");
  show("keysResult", Boolean(viewer) && (status === "done" || status === "error"));
  show("rescanBtn", Boolean(viewer) && status !== "loading" && !batchActive());
  if (!viewer || status === "loading" || status === "idle") return;

  const list = $("keysList");
  list.replaceChildren();
  show("partialNote", status === "done" && partial);

  if (status === "error") {
    setText("keysSummary", `Couldn't scan this wallet (${error}). You can still look up a key owner below.`);
    show("sellAllBtn", false);
    show("batch", false);
    return;
  }

  const summary = $("keysSummary");
  if (holdings.length) {
    const strong = Object.assign(document.createElement("strong"), { textContent: `${chain.formatEth(sumValue(holdings))} ETH` });
    summary.replaceChildren("Worth about ", strong, ` across ${people(holdings.length)}.`);
  } else {
    summary.textContent = "";
    const li = Object.assign(document.createElement("li"), { className: "none" });
    li.textContent = "No keys found in this wallet. If you think that's wrong, look up the key owner below.";
    list.append(li);
  }

  const toSell = sellable();
  show("sellAllBtn", canSell() && toSell.length > 0 && !state.batch);
  setText("sellAllBtn", toSell.length > 1 ? `Sell all · ${chain.formatEth(sumValue(toSell))} ETH` : "Sell all");

  renderBatch();

  const statusOf = new Map(state.batch?.items.map((it) => [it.subject, it]) ?? []);
  holdings.forEach((h, i) => list.append(keyRow(h, i, statusOf.get(h.subject))));
  markCurrent();
}

function keyRow(h, index, batchItem) {
  const row = $("keyRowTpl").content.firstElementChild.cloneNode(true);
  const btn = row.querySelector(".key-row");
  btn.dataset.subject = h.subject;
  btn.style.animationDelay = `${Math.min(index, 8) * 40}ms`;
  btn.disabled = batchActive();
  paintAvatar(row.querySelector(".avatar"), h.subject);
  row.querySelector(".key-addr").textContent = short(h.subject);
  row.querySelector(".you-badge").hidden = !same(h.subject, state.viewer);
  row.querySelector(".key-sub").textContent = h.max > 0n
    ? `${plural(h.balance, "key")} · ${h.max} sellable`
    : `${plural(h.balance, "key")} · last key, can't sell`;

  const value = row.querySelector(".key-value");
  if (batchItem) {
    value.dataset.status = batchItem.status;
    value.textContent = ROW_STATUS[batchItem.status];
    if (batchItem.error) value.title = batchItem.error;
  } else {
    value.textContent = h.value > 0n ? `${chain.formatEth(h.value)} ETH` : "–";
    value.classList.toggle("zero", !(h.value > 0n));
  }
  btn.addEventListener("click", () => select(h.subject));
  return row;
}

function markCurrent() {
  for (const b of $("keysList").querySelectorAll(".key-row")) {
    b.setAttribute("aria-current", String(b.dataset.subject === state.position?.subject));
  }
}

function renderBatch() {
  const b = state.batch;
  show("batch", Boolean(b));
  if (!b) return;
  const n = b.items.length;
  const finished = b.items.filter((it) => it.status !== "waiting" && it.status !== "active").length;
  const sold = b.items.filter((it) => it.status === "sold");
  const failed = b.items.filter((it) => it.status === "failed");

  show("batchConfirm", b.phase === "confirm");
  show("batchStopBtn", b.phase === "running");
  show("batchBarWrap", b.phase !== "confirm");
  show("batchDoneBtn", b.phase === "done");
  $("batchStopBtn").disabled = b.stop;
  setText("batchStopBtn", b.stop ? "Stopping after this one…" : "Stop");
  $("batchBar").style.width = `${n ? (finished / n) * 100 : 0}%`;

  if (b.phase === "confirm") {
    setText("batchTitle", `Sell keys of ${people(n)}?`);
    setText("batchText", `You'll confirm ${plural(n, "transaction")} in your wallet${n > 1 ? ", one per person," : ""} and receive about ${chain.formatEth(sumValue(b.items))} ETH in total, minus gas. You can stop at any time.`);
  } else if (b.phase === "running") {
    const current = b.items[b.index];
    setText("batchTitle", `Selling ${Math.max(b.index, 0) + 1} of ${n}`);
    setText("batchText", current ? `${short(current.subject)}: ${PHASE_TEXT[b.step] ?? "Preparing…"}` : "Preparing…");
  } else {
    setText("batchTitle", sold.length ? "Done" : "Nothing sold");
    const parts = [];
    if (sold.length) parts.push(`Sold keys of ${people(sold.length)} for about ${chain.formatEth(sumValue(sold))} ETH.`);
    if (failed.length) parts.push(`${people(failed.length)} failed: ${failed[0].error}`);
    if (b.error) parts.push(b.error);
    setText("batchText", parts.join(" ") || "Nothing was sold.");
  }
}

// ---------- Render: sell card ----------

function sellButtonState() {
  const p = state.position;
  if (busy()) return { text: "Selling…", disabled: true, busy: true };
  if (!state.account) return { text: chain.hasWallet() ? "Connect wallet to sell" : "Install a wallet to sell", disabled: !chain.hasWallet() };
  if (!canSell()) return { text: `Switch your wallet to ${short(state.viewer)} to sell`, disabled: true };
  if (p.balance == null) return { text: "Loading…", disabled: true };
  if (p.balance === 0n) return { text: "This wallet holds none of these keys", disabled: true };
  if (p.max === 0n) return { text: "Can't sell the last key", disabled: true, note: "The contract never lets anyone sell a person's last remaining key." };
  if (state.amount < 1n || state.amount > p.max) return { text: `Choose 1 to ${p.max}`, disabled: true };
  return { text: `Sell ${plural(state.amount, "key")}`, disabled: state.quoteLoading || !state.quote };
}

function renderSell() {
  const p = state.position;
  show("sellCard", Boolean(p));
  if (!p) return;
  const { phase, hash, error, sold } = state.sale;

  paintAvatar($("sellAvatar"), p.subject);
  setText("sellAddr", short(p.subject));
  $("sellAddr").title = p.subject;
  show("sellYou", same(p.subject, state.viewer));
  $("sellLink").href = `${CHAIN.explorer}/address/${p.subject}`;

  const known = (v) => (v == null ? "–" : v.toString());
  setText("statBalance", known(p.balance));
  setText("statSupply", known(p.supply));
  setText("statMax", p.balance == null ? "–" : p.max.toString());

  // Amount + quote (shown even when viewing someone else's wallet)
  const locked = busy() || !(p.max > 0n);
  $("amountInput").disabled = locked;
  $("decBtn").disabled = locked || state.amount <= 1n;
  $("incBtn").disabled = locked || state.amount >= p.max;
  $("maxBtn").disabled = locked;
  if (document.activeElement !== $("amountInput")) $("amountInput").value = state.amount.toString();

  $("receive").classList.toggle("loading", state.quoteLoading);
  setText("receiveEth", state.quote ? chain.formatEth(state.quote.net) : "–");
  setText("receiveBreakdown", state.quote
    ? `Price ${chain.formatEth(state.quote.gross)} ETH − ${chain.formatEth(state.quote.fee)} ETH fees`
    : "");

  const b = sellButtonState();
  const sellBtn = $("sellBtn");
  sellBtn.textContent = b.text;
  sellBtn.disabled = b.disabled;
  sellBtn.classList.toggle("busy", Boolean(b.busy));
  show("sellNote", Boolean(b.note));
  if (b.note) setText("sellNote", b.note);

  // Progress, result, error
  show("sellForm", phase !== "done");
  show("progress", busy());
  const current = PHASES.indexOf(phase);
  for (const li of $("progress").children) {
    const i = PHASES.indexOf(li.dataset.phase);
    li.classList.toggle("done", i < current);
    li.classList.toggle("active", i === current);
  }

  show("result", phase === "done");
  if (phase === "done") {
    setText("resultText", sold.net != null
      ? `Sold ${plural(sold.amount, "key")} for about ${chain.formatEth(sold.net)} ETH`
      : `Sold ${plural(sold.amount, "key")}`);
  }
  show("resultLink", Boolean(hash));
  if (hash) $("resultLink").href = `${CHAIN.explorer}/tx/${hash}`;

  show("sellError", phase === "error");
  if (phase === "error") setText("sellError", error);
}

// ---------- Wallet ----------

async function connect() {
  if (!chain.hasWallet()) return toast("No wallet found in this browser");
  try {
    setAccount(await chain.requestAccount());
  } catch (e) {
    toast(chain.friendlyError(e));
  }
}

async function onWalletClick() {
  if (!state.account) return connect();
  if (state.chainId !== CHAIN.id) {
    try { await chain.switchToBase(); } catch (e) { toast(chain.friendlyError(e)); }
    return;
  }
  copy(state.account);
}

function setAccount(account) {
  if (account === state.account) return;
  const previous = state.account;
  state.account = account;
  state.ethBalance = null;
  state.chainId = null;
  if (state.batch?.phase === "running") state.batch.stop = true; // never keep selling from a different wallet
  renderWallet();

  if (account) {
    chain.walletChainId().then((id) => { state.chainId = id; renderWallet(); }).catch(() => {});
    refreshEth();
  }
  // The list follows the connected wallet unless the user searched for a different one.
  if (!state.viewer || same(state.viewer, previous)) setViewer(account);
  else { renderKeys(); renderSell(); }
}

function refreshEth() {
  const account = state.account;
  chain.ethBalance(account).then((wei) => {
    if (state.account === account) { state.ethBalance = wei; renderWallet(); }
  }).catch(() => {});
}

// ---------- Holdings ----------

function setViewer(address) {
  state.viewer = address;
  state.batch = null;
  state.scan = { status: "idle", holdings: [], partial: false, error: null };
  setUrlParam("wallet", address && !same(address, state.account) ? address : null);
  if (state.position) select(state.position.subject, { scroll: false });
  renderKeys();
  if (address) scan();
}

async function scan() {
  const viewer = state.viewer;
  state.batch = null;
  state.scan = { status: "loading", holdings: [], partial: false, error: null };
  setText("keysProgress", "Reading wallet history…");
  renderKeys();
  try {
    const { holdings, partial } = await chain.findHoldings(viewer, (note) => {
      if (state.viewer === viewer) setText("keysProgress", `${note}…`);
    });
    if (state.viewer !== viewer) return;
    state.scan = { status: "done", holdings, partial, error: null };
    renderKeys();
    if (holdings.length === 1 && !state.position) select(holdings[0].subject);
  } catch (e) {
    if (state.viewer !== viewer) return;
    state.scan = { status: "error", holdings: [], partial: false, error: chain.friendlyError(e) };
    renderKeys();
  }
}

/** Validates an address input; shows `errorId` and returns null when it isn't one. */
function readAddressInput(inputId, errorId) {
  const input = $(inputId);
  const value = input.value.trim();
  const valid = chain.isAddress(value);
  input.setAttribute("aria-invalid", String(!valid));
  show(errorId, !valid);
  if (!valid) setText(errorId, "That doesn't look like a wallet address. It should start with 0x and have 42 characters.");
  return valid ? chain.checksum(value) : null;
}

function search(event) {
  event.preventDefault();
  const address = readAddressInput("searchInput", "searchError");
  if (!address) return;
  $("searchInput").blur();
  closeSell();
  setViewer(address);
}

function lookUp(event) {
  event.preventDefault();
  const address = readAddressInput("manualInput", "manualError");
  if (address) select(address);
}

// ---------- Single sale ----------

async function select(subject, { scroll = true } = {}) {
  if (batchActive()) return;
  const seq = ++selectSeq;
  const sameSubject = state.position?.subject === subject;
  state.position = { subject, supply: null, balance: null, max: 0n };
  if (!sameSubject) state.quote = null;
  state.sale = IDLE_SALE;
  markCurrent();
  renderSell();
  if (scroll && !sameSubject) $("sellCard").scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const position = await chain.readPosition(subject, holder());
    if (seq !== selectSeq) return;
    state.position = position;
    state.amount = position.max > 0n ? position.max : 1n; // default: sell everything sellable
    renderSell();
    updateQuote();
  } catch (e) {
    if (seq !== selectSeq) return;
    state.sale = { ...IDLE_SALE, phase: "error", error: `Couldn't read this account: ${chain.friendlyError(e)}` };
    renderSell();
  }
}

function closeSell() {
  selectSeq++;
  state.position = null;
  state.quote = null;
  state.sale = IDLE_SALE;
  markCurrent();
  renderSell();
}

async function updateQuote() {
  const seq = ++quoteSeq;
  const p = state.position;
  const amount = state.amount;
  if (!p || p.max === 0n || amount < 1n || amount > p.max) {
    state.quote = null;
    state.quoteLoading = false;
    renderSell();
    return;
  }
  state.quoteLoading = true;
  renderSell();
  let q = null;
  try { q = await chain.quote(p.subject, amount); } catch { /* shown as "–" */ }
  if (seq !== quoteSeq) return;
  state.quote = q;
  state.quoteLoading = false;
  renderSell();
}

let quoteTimer;
function setAmount(amount, { debounce = false } = {}) {
  state.amount = amount;
  if (state.sale.phase === "error") state.sale = IDLE_SALE;
  clearTimeout(quoteTimer);
  if (!debounce) return updateQuote();
  state.quoteLoading = true;
  renderSell();
  quoteTimer = setTimeout(updateQuote, 300);
}

async function sell() {
  if (!state.account) return connect();
  const { subject, max } = state.position;
  const amount = state.amount;
  if (!canSell() || amount < 1n || amount > max || busy()) return;
  const expected = state.quote?.net ?? null;

  const setSale = (patch) => { state.sale = { ...state.sale, ...patch }; renderSell(); };
  setSale({ phase: "check", hash: null, error: null, sold: null });
  try {
    const hash = await chain.sellKeys({
      subject, amount, account: state.account,
      onPhase: (phase, txHash) => setSale({ phase, hash: txHash ?? state.sale.hash }),
    });
    setSale({ phase: "done", hash, sold: { amount, net: expected } });
  } catch (e) {
    setSale({ phase: "error", error: chain.friendlyError(e) });
  }
  refreshAfterSale(subject);
}

/** Re-reads one subject after a sale and updates the open sell card and the holdings list. */
async function refreshAfterSale(subject) {
  refreshEth();
  const viewer = state.viewer;
  try {
    const position = await chain.readPosition(subject, viewer);
    if (state.viewer !== viewer) return;
    if (state.position?.subject === subject) {
      state.position = position;
      if (state.amount > position.max) state.amount = position.max > 0n ? position.max : 1n;
      updateQuote();
    }
    const holdings = state.scan.holdings.filter((h) => h.subject !== subject);
    if (position.balance > 0n) {
      position.value = position.max > 0n ? (await chain.quote(subject, position.max)).net : 0n;
      holdings.push(position);
      holdings.sort(chain.byValue);
    }
    if (state.scan.status === "done" && state.viewer === viewer) {
      state.scan = { ...state.scan, holdings };
      renderKeys();
    }
  } catch { /* the next rescan will catch up */ }
}

// ---------- Sell all ----------

function confirmSellAll() {
  const items = sellable().map((h) => ({ subject: h.subject, amount: h.max, value: h.value, status: "waiting", error: null }));
  if (!items.length) return;
  closeSell();
  state.batch = { phase: "confirm", items, index: -1, step: null, stop: false, error: null };
  renderKeys();
  $("batch").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runSellAll() {
  const b = state.batch;
  const account = state.account;
  b.phase = "running";
  renderKeys();

  for (const [i, item] of b.items.entries()) {
    if (b.stop || !same(state.account, account) || !canSell()) break;
    b.index = i;
    b.step = null;
    item.status = "active";
    renderKeys();
    try {
      // Re-read right before selling: balances and prices may have moved since the scan.
      const position = await chain.readPosition(item.subject, account);
      if (position.max === 0n) { item.status = "skipped"; continue; }
      item.amount = position.max;
      item.value = (await chain.quote(item.subject, item.amount)).net;
      await chain.sellKeys({
        subject: item.subject, amount: item.amount, account,
        onPhase: (phase) => { b.step = phase; renderBatch(); },
      });
      item.status = "sold";
    } catch (e) {
      if (chain.isUserRejection(e)) {
        item.status = "skipped";
        b.error = i < b.items.length - 1 ? "You cancelled in your wallet, so the rest were skipped." : "You cancelled in your wallet.";
        break;
      }
      item.status = "failed";
      item.error = chain.friendlyError(e);
    }
    renderKeys();
  }

  const leftOver = b.items.filter((it) => it.status === "waiting");
  if (leftOver.length && !b.error) {
    b.error = same(state.account, account) ? "Stopped. The rest were skipped." : "Your wallet changed, so the rest were skipped.";
  }
  for (const item of leftOver) item.status = "skipped";
  b.phase = "done";
  renderKeys();
  refreshEth();
}

function finishSellAll() {
  state.batch = null;
  scan(); // fresh balances and values after the sales
}

// ---------- Tip ----------

function initTip() {
  setText("tipAddr", TIP_ADDRESS);
  $("tipLink").href = `${CHAIN.explorer}/address/${TIP_ADDRESS}`;
  $("tipCopyBtn").addEventListener("click", () => copy(TIP_ADDRESS));
}

// ---------- Wiring ----------

function init() {
  $("contractLink").href = `${CHAIN.explorer}/address/${KEYS}`;
  $("contractLink").textContent = short(KEYS);

  $("themeBtn").addEventListener("click", cycleTheme);
  $("walletBtn").addEventListener("click", onWalletClick);
  $("connectBtn").addEventListener("click", connect);
  $("searchForm").addEventListener("submit", search);
  $("searchInput").addEventListener("input", () => { $("searchInput").removeAttribute("aria-invalid"); show("searchError", false); });
  $("rescanBtn").addEventListener("click", scan);
  $("viewMineBtn").addEventListener("click", () => { $("searchInput").value = ""; closeSell(); setViewer(state.account); });
  $("manualForm").addEventListener("submit", lookUp);
  $("manualInput").addEventListener("input", () => { $("manualInput").removeAttribute("aria-invalid"); show("manualError", false); });

  $("sellAllBtn").addEventListener("click", confirmSellAll);
  $("batchStartBtn").addEventListener("click", runSellAll);
  $("batchCancelBtn").addEventListener("click", () => { state.batch = null; renderKeys(); });
  $("batchStopBtn").addEventListener("click", () => { state.batch.stop = true; renderBatch(); });
  $("batchDoneBtn").addEventListener("click", finishSellAll);

  $("closeSellBtn").addEventListener("click", closeSell);
  $("copyBtn").addEventListener("click", () => copy(state.position.subject));
  $("decBtn").addEventListener("click", () => setAmount(state.amount - 1n));
  $("incBtn").addEventListener("click", () => setAmount(state.amount + 1n));
  $("maxBtn").addEventListener("click", () => setAmount(state.position.max));
  $("amountInput").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "");
    e.target.value = digits;
    setAmount(digits ? BigInt(digits) : 0n, { debounce: true });
  });
  $("amountInput").addEventListener("blur", () => renderSell());
  $("sellBtn").addEventListener("click", sell);
  $("resultDoneBtn").addEventListener("click", () => {
    state.sale = IDLE_SALE;
    if (state.position?.max > 0n) renderSell(); else closeSell();
  });

  initTip();
  renderTheme();
  renderWallet();
  renderKeys();

  const params = new URLSearchParams(location.search);
  const wallet = params.get("wallet");
  const subject = params.get("subject");
  if (wallet && chain.isAddress(wallet)) {
    $("searchInput").value = chain.checksum(wallet);
    setViewer(chain.checksum(wallet));
  }
  if (subject && chain.isAddress(subject)) select(chain.checksum(subject));

  if (chain.hasWallet()) {
    chain.onWalletChange({
      account: (a) => setAccount(a),
      chain: (id) => { state.chainId = id; renderWallet(); },
    });
    chain.currentAccount().then(setAccount).catch(() => {});
  }
}

init();
