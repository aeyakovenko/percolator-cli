/**
 * Single source of truth for Bounty-5 safety-critical, init-immutable parameters.
 *
 * The deploy writes these into the on-chain market AND the manifest; the verify
 * test (`npm test` → scripts/verify-manifest.ts) asserts the manifest (and,
 * opt-in, the live on-chain config) still agree with them. This closes CLI #72/#77:
 * a stale manifest value (e.g. the legacy v12.21 devnet cap `permissionlessResolve
 * StaleSlots = 100` instead of `6_480_000`) can no longer drift silently past the
 * deploy guard or CI.
 */
export const BOUNTY5_PARAMS = {
  /** ~30 days at ~400ms/slot. NOT the 100-slot (~40s) v12.21 devnet cap. */
  permissionlessResolveStaleSlots: 6_480_000,
  /** ~24h post-resolve grace. */
  forceCloseDelaySlots: 216_000,
  /** mm = im → 20× nominal leverage. */
  maintenanceMarginBps: 500,
  leverage: 20,
  /** 20% of non-zero-market trade fees + backing yield → market 0. */
  feeRedirectToMarket0Bps: 2000,
  /** per-domain insurance seed (0.5 SOL × domains 0/2/4 = 1.5 SOL nominal). */
  insurancePerDomainLamports: 500_000_000,
} as const;

export type Bounty5Params = typeof BOUNTY5_PARAMS;

/** Fields the manifest MUST match exactly (the safety-critical immutables). */
export const MANIFEST_SAFETY_FIELDS: (keyof Bounty5Params & string)[] = [
  "permissionlessResolveStaleSlots",
  "forceCloseDelaySlots",
  "maintenanceMarginBps",
  "leverage",
];
