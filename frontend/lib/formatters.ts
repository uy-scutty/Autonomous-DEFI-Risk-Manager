import { HF_PRECISION, PRICE_PRECISION } from "./contracts";

// ─── Health Factor ────────────────────────────────────────────────────────────

/** Convert raw 18-dec bigint HF to JS number */
export function parseHF(raw: bigint): number {
  if (raw >= BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")) {
    return Infinity; // type(uint256).max = no debt
  }
  return Number(raw) / Number(HF_PRECISION);
}

/** Format HF number for display */
export function formatHF(hf: number): string {
  if (!isFinite(hf)) return "∞";
  return hf.toFixed(2);
}

/** Return band string from HF number */
export function getHFBand(hf: number): "SAFE" | "WARNING" | "ACTION" | "CRITICAL" {
  if (!isFinite(hf) || hf > 1.6) return "SAFE";
  if (hf >= 1.4)                  return "WARNING";
  if (hf >= 1.0)                  return "ACTION";
  return "CRITICAL";
}

/** Tailwind colour class for a band */
export function getBandColor(band: ReturnType<typeof getHFBand>): string {
  const map = {
    SAFE:     "text-safe",
    WARNING:  "text-warning",
    ACTION:   "text-action",
    CRITICAL: "text-critical",
  };
  return map[band];
}

/** Hex colour value for charts / canvas */
export function getBandHex(band: ReturnType<typeof getHFBand>): string {
  const map = {
    SAFE:     "#00e676",
    WARNING:  "#ffea00",
    ACTION:   "#ff6d00",
    CRITICAL: "#ff1744",
  };
  return map[band];
}

// ─── USD Values ───────────────────────────────────────────────────────────────

/** Convert raw 8-dec Aave USD bigint to JS number */
export function parseUSD(raw: bigint): number {
  return Number(raw) / Number(PRICE_PRECISION);
}

/** Format USD number for display */
export function formatUSD(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(2)}K`;
  return `$${usd.toFixed(2)}`;
}

// ─── Addresses ────────────────────────────────────────────────────────────────

export function shortenAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Time ─────────────────────────────────────────────────────────────────────

export function timeAgo(timestampSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestampSeconds;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Arbiscan links ───────────────────────────────────────────────────────────

export function arbiscanTx(hash: string, chainId = 421614): string {
  const base = chainId === 42161
    ? "https://arbiscan.io"
    : "https://sepolia.arbiscan.io";
  return `${base}/tx/${hash}`;
}

export function arbiscanAddr(address: string, chainId = 421614): string {
  const base = chainId === 42161
    ? "https://arbiscan.io"
    : "https://sepolia.arbiscan.io";
  return `${base}/address/${address}`;
}

// ─── Basis points ─────────────────────────────────────────────────────────────

export function bpToPercent(bp: number): string {
  return `${(bp / 100).toFixed(0)}%`;
}

export function hfToBigInt(hf: number): bigint {
  return BigInt(Math.round(hf * 1e18));
}
