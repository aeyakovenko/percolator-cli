/**
 * Coverage tier computation — mirrors the on-chain matcher v2 logic exactly.
 *
 * The market prices its own fragility.
 *
 * | Coverage     | Tier       | Spread Effect          | Fill Effect             |
 * |-------------|------------|------------------------|-------------------------|
 * | < 10%       | CRITICAL   | max_spread (widest)    | fill capped at 25%      |
 * | 10% - 25%   | FRAGILE    | spread widens sharply  | fill capped at 50%      |
 * | 25% - 100%  | NORMAL     | linear discount        | full fill               |
 * | 100% - 200% | STRONG     | tighter spreads        | full fill               |
 * | > 200%      | FORTIFIED  | min_spread (tightest)  | fill + 50% bonus        |
 */

export type TierName = "CRITICAL" | "FRAGILE" | "NORMAL" | "STRONG" | "FORTIFIED";

export interface CoverageTier {
  name: TierName;
  coveragePct: number;         // raw coverage as percentage (can exceed 100)
  coverageBps: number;         // raw coverage in bps
  fillCapPct: number;          // fill limit as % of base max_fill
  spreadEffect: string;        // human description
  color: string;               // CSS color for the tier
  bgColor: string;             // CSS background color
  borderColor: string;         // CSS border color
}

// Tier boundaries in bps (match on-chain constants exactly)
const TIER_CRITICAL_BPS = 1_000;   // 10%
const TIER_FRAGILE_BPS  = 2_500;   // 25%
const TIER_NORMAL_BPS   = 10_000;  // 100%
const TIER_STRONG_BPS   = 20_000;  // 200%

/**
 * Compute the active coverage tier from insurance and OI values.
 */
export function computeTier(insurance: bigint, oi: bigint): CoverageTier {
  let coverageBps: number;
  if (oi > 0n) {
    coverageBps = Number((insurance * 10_000n) / oi);
  } else {
    coverageBps = insurance > 0n ? TIER_STRONG_BPS : TIER_FRAGILE_BPS;
  }
  const coveragePct = coverageBps / 100;

  if (coverageBps < TIER_CRITICAL_BPS) {
    return {
      name: "CRITICAL",
      coveragePct,
      coverageBps,
      fillCapPct: 25,
      spreadEffect: "Maximum spread. Fills capped at 25%.",
      color: "#ef4444",
      bgColor: "rgba(239, 68, 68, 0.08)",
      borderColor: "rgba(239, 68, 68, 0.25)",
    };
  }
  if (coverageBps < TIER_FRAGILE_BPS) {
    return {
      name: "FRAGILE",
      coveragePct,
      coverageBps,
      fillCapPct: 50,
      spreadEffect: "Spread widens sharply. Fills capped at 50%.",
      color: "#f97316",
      bgColor: "rgba(249, 115, 22, 0.08)",
      borderColor: "rgba(249, 115, 22, 0.25)",
    };
  }
  if (coverageBps < TIER_NORMAL_BPS) {
    return {
      name: "NORMAL",
      coveragePct,
      coverageBps,
      fillCapPct: 100,
      spreadEffect: "Standard spread with insurance discount.",
      color: "#a3a3a3",
      bgColor: "rgba(163, 163, 163, 0.06)",
      borderColor: "rgba(163, 163, 163, 0.15)",
    };
  }
  if (coverageBps < TIER_STRONG_BPS) {
    return {
      name: "STRONG",
      coveragePct,
      coverageBps,
      fillCapPct: 100,
      spreadEffect: "Full insurance discount. Tight spreads.",
      color: "#22c55e",
      bgColor: "rgba(34, 197, 94, 0.08)",
      borderColor: "rgba(34, 197, 94, 0.25)",
    };
  }
  return {
    name: "FORTIFIED",
    coveragePct,
    coverageBps,
    fillCapPct: 150,
    spreadEffect: "Minimum spread. Fill bonus +50%.",
    color: "#3b82f6",
    bgColor: "rgba(59, 130, 246, 0.08)",
    borderColor: "rgba(59, 130, 246, 0.25)",
  };
}

/**
 * All tier definitions for rendering the tier ladder.
 */
export const TIER_LADDER: { name: TierName; threshold: string; fillCap: string; color: string }[] = [
  { name: "CRITICAL",  threshold: "< 10%",      fillCap: "25%",  color: "#ef4444" },
  { name: "FRAGILE",   threshold: "10% – 25%",   fillCap: "50%",  color: "#f97316" },
  { name: "NORMAL",    threshold: "25% – 100%",  fillCap: "100%", color: "#a3a3a3" },
  { name: "STRONG",    threshold: "100% – 200%", fillCap: "100%", color: "#22c55e" },
  { name: "FORTIFIED", threshold: "> 200%",      fillCap: "150%", color: "#3b82f6" },
];
