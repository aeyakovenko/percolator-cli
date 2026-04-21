import { PublicKey } from "@solana/web3.js";
import type { InitMarketArgs } from "../src/abi/instructions.js";

// =============================================================================
// TEST defaults — tuned to make effects observable in ~60 seconds.
// DO NOT use these for a real-money market. Use `prodInitMarketArgs` below.
//
// Deviations from production sanity:
//   - maintenanceFeePerSlot: 0 (tests that need non-zero fees override it
//     with a large value to make the sweep readable in one crank, e.g.
//     check-maint-fees.ts uses 1_000_000 = ~$216k/day/account).
//   - hMin=4, hMax=200: warmup 1.6–80 s so tests don't wait hours.
//   - min_initial_deposit=1 USDC: tests use small amounts.
//   - permissionlessResolveStaleSlots=0, forceCloseDelaySlots=0: admin
//     can resolve instantly. Fine for tests, unsafe if admin dies.
//   - maxCrankStalenessSlots=10000 (~66 min at 400ms/slot): permissive
//     so automation hiccups don't cause spurious rejects.
// =============================================================================
export function defaultInitMarketArgs(
  admin: PublicKey,
  mint: PublicKey,
  overrides: Partial<InitMarketArgs> = {},
): InitMarketArgs {
  return {
    admin,
    collateralMint: mint,
    indexFeedId: "0000000000000000000000000000000000000000000000000000000000000000",
    maxStalenessSecs: "60",
    confFilterBps: 200,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: "100000000", // $100
    maintenanceFeePerSlot: "0",
    maxInsuranceFloor: "10000000000000000",
    minOraclePriceCapE2bps: "0",
    hMin: "4",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "10",
    maxAccounts: "64",
    insuranceFloor: "0",
    hMax: "200",
    maxCrankStalenessSlots: "10000",
    liquidationFeeBps: "100",
    liquidationFeeCap: "1000000000",
    resolvePriceDeviationBps: "5000",
    minLiquidationAbs: "100000",
    minInitialDeposit: "1000000",
    minNonzeroMmReq: "100000",
    minNonzeroImReq: "200000",
    // withdrawal disabled by default — tests that need it set both fields
    insuranceWithdrawMaxBps: 0,
    insuranceWithdrawCooldownSlots: "0",
    permissionlessResolveStaleSlots: "0",
    fundingHorizonSlots: "500",
    fundingKBps: "100",
    fundingMaxPremiumBps: "500",
    fundingMaxBpsPerSlot: "10",
    markMinFee: "0",
    forceCloseDelaySlots: "0",
    ...overrides,
  };
}

// =============================================================================
// PRODUCTION defaults — tuned for a real deployment.
//
// Assumes:
//   - 400 ms/slot (Solana mainnet)       → 216_000 slots/day
//   - unit_scale = 0 (1 lamport / 1 µUSDC = 1 engine unit)
//
// Calibrations:
//
//   maintenanceFeePerSlot:
//     Target ≈ $5/day per account.
//     USDC (6 dec): 25 × 216 000 = 5.4 M µUSDC = $5.40/day.
//     SOL (9 dec, unit_scale=0): override to 250 → 54 M lamports =
//       0.054 SOL/day (≈$5 at SOL=$100).
//
//   hMin / hMax:
//     Warmup (§6.1) between 1 000 and 50 000 slots ≈ 7 min to 5.5 hours.
//     Wide enough to survive a brief Pyth outage; short enough that UX
//     doesn't feel broken.
//
//   permissionlessResolveStaleSlots:
//     100 000 slots ≈ 11 hours — the program's hard ceiling is
//     `max_accrual_dt_slots` (100 000, engine constant). Must exceed
//     `max_crank_staleness_slots` AND be ≥ `h_max` so warmup cohorts
//     mature before the market becomes permissionlessly resolvable.
//     After this much oracle staleness anyone can ResolvePermissionless.
//
//   forceCloseDelaySlots:
//     200 000 slots ≈ 22 hours. Only relevant once the market is
//     Resolved: after this delay, anyone can ForceCloseResolved stuck
//     positions. Upper cap 10 000 000 slots.
//
//     Together these two and the four-way authority split
//     (admin / oracle / insurance / close) form the
//     "traders-are-rug-proof" configuration the program's guard
//     comments describe.
//
//   maxCrankStalenessSlots:
//     500 slots (≈3 min 20 s). Tight enough to keep margin checks
//     honest, loose enough that keeper backoff / fee-market spikes
//     don't trigger spurious risk-reduction mode.
//
//   minInitialDeposit / min_nonzero_*_req:
//     $10 floor ($10 / $0.10 MM / $0.20 IM). Keeps dust accounts out,
//     matches the $5/day fee (account has ≥ 2 days survival with no
//     trading activity).
//
//   funding*:
//     Unchanged from test (they're protocol-level envelopes the engine
//     enforces regardless). Review before launch for the specific
//     asset's expected premium range.
//
// Non-Hyperp markets MUST override `indexFeedId` and set either
// `permissionlessResolveStaleSlots > 0` OR `minOraclePriceCapE2bps > 0`
// (the program's resolvability invariant — otherwise init fails).
// =============================================================================
export function prodInitMarketArgs(
  admin: PublicKey,
  mint: PublicKey,
  overrides: Partial<InitMarketArgs> = {},
): InitMarketArgs {
  return {
    admin,
    collateralMint: mint,

    // --- Oracle / mark ---
    indexFeedId: "0000000000000000000000000000000000000000000000000000000000000000", // Hyperp; override for Pyth
    maxStalenessSecs: "30",     // 30 s Pyth freshness
    confFilterBps: 50,          // reject if conf > 0.5 %
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: "100000000", // override to current index at deploy

    // --- Maintenance fee: ~$5/day on USDC-6 collateral ---
    // For SOL-9 collateral set 250 (same $5/day target at SOL=$100).
    maintenanceFeePerSlot: "25",

    // --- Per-market admin ceilings (set once, immutable) ---
    maxInsuranceFloor:       "100000000000000",  // $100 M ceiling (u128 µUSDC)
    minOraclePriceCapE2bps:  "0",                // 0 = no floor; non-Hyperp must set this OR perm-resolve

    // --- Risk params ---
    hMin:                    "1000",             // ~7 min warmup floor
    hMax:                    "50000",            // ~5.5 hour warmup ceiling
    maintenanceMarginBps:    "500",              // 5 % MM
    initialMarginBps:        "1000",             // 10 % IM → 10× max leverage
    tradingFeeBps:           "10",               // 0.1 %
    maxAccounts:             "4096",             // full capacity
    insuranceFloor:          "0",                // admin can raise later
    maxCrankStalenessSlots:  "500",              // ~3 min 20 s
    liquidationFeeBps:       "100",              // 1 % liquidation fee
    liquidationFeeCap:       "1000000000",       // $1 000 max per liquidation
    resolvePriceDeviationBps:"500",              // 5 % max settlement-price deviation
    minLiquidationAbs:       "1000000",          // $1 min liquidation size
    minInitialDeposit:       "10000000",         // $10 min deposit
    minNonzeroMmReq:         "100000",           // $0.10 min MM req
    minNonzeroImReq:         "200000",           // $0.20 min IM req

    // --- Extended tail ---
    // Insurance withdrawal: disabled by default. Set insurance_authority
    // under UpdateAuthority once operational rhythm is established.
    insuranceWithdrawMaxBps:         0,
    insuranceWithdrawCooldownSlots:  "0",

    // Traders-are-rug-proof: even if admin key is lost, anyone can
    // resolve after 11 h of oracle staleness, then force-close stuck
    // positions 22 h after resolution.
    permissionlessResolveStaleSlots: "100000",   // ~11 h (hard cap = max_accrual_dt_slots)
    forceCloseDelaySlots:            "200000",   // ~22 h (cap = MAX_FORCE_CLOSE_DELAY_SLOTS = 10 M)

    // Funding — enforce the engine's envelope; review per-asset.
    fundingHorizonSlots:  "7200",    // ~48 min EWMA
    fundingKBps:          "100",     // 1× multiplier
    fundingMaxPremiumBps: "500",     // 5 % premium cap
    fundingMaxBpsPerSlot: "1",       // 1 bps/slot (≈21.6 %/day cap; tighten if spec requires)

    // Fee-weighted EWMA on trade marks
    markMinFee: "0",

    ...overrides,
  };
}
