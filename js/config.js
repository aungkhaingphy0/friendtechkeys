// friend.tech shares contract (FriendtechSharesV1) on Base.
export const KEYS = "0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4";

// Shown in the "Tip the developer" card.
export const TIP_ADDRESS = "0xE107Feed997Cdd01bf949f7567cC15118ed77777";

export const CHAIN = {
  id: 8453,
  hex: "0x2105",
  name: "Base",
  rpc: "https://mainnet.base.org", // also offered to the wallet when adding Base
  // Free public endpoints, tried in turn. Each rate-limits (mainnet.base.org: 25 requests/second).
  readRpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
  explorer: "https://basescan.org",
  blockscout: "https://base.blockscout.com",
};

// Multicall3, deployed at the same address on every major EVM chain. Lets one eth_call carry hundreds of reads.
export const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MULTICALL_CHUNK = 200; // reads per eth_call

export const SCAN_PAGES = 200; // Blockscout returns 50 transactions per page, so up to 10,000 sent transactions

export const SELECTORS = {
  buy: "0x6945b123",  // buyShares(address,uint256)
  sell: "0xb51d0534", // sellShares(address,uint256)
};

export const ABI = [
  "function sharesBalance(address subject, address holder) view returns (uint256)",
  "function sharesSupply(address subject) view returns (uint256)",
  "function getSellPrice(address subject, uint256 amount) view returns (uint256)",
  "function getSellPriceAfterFee(address subject, uint256 amount) view returns (uint256)",
  "function sellShares(address subject, uint256 amount) payable",
];
