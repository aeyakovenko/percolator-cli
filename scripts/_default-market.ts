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
//   - newAccountFee=0: tests can spawn accounts for free.
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
    hMin: "4",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "10",
    maxAccounts: "64",
    newAccountFee: "0",
    hMax: "200",
    // v12.21: ignored on chain (read+discarded). Send 0 placeholder.
    maxCrankStalenessSlots: "0",
    liquidationFeeBps: "100",
    liquidationFeeCap: "1000000000",
    resolvePriceDeviationBps: "5000",
    minLiquidationAbs: "100000",
    minNonzeroMmReq: "100000",
    minNonzeroImReq: "200000",
    // v12.21: per-slot price-move cap. Must be > 0; envelope:
    //   max_price_move_bps_per_slot * MAX_ACCRUAL_DT_SLOTS(100) +
    //   funding_part + liquidation_fee_bps <= maintenance_margin_bps
    // 2 bps/slot * 100 = 200 bps headroom out of 500 bps MM.
    maxPriceMoveBpsPerSlot: "2",
    // withdrawal disabled by default — tests that need it set both fields
    insuranceWithdrawMaxBps: 0,
    insuranceWithdrawCooldownSlots: "0",
    permissionlessResolveStaleSlots: "0",
    fundingHorizonSlots: "500",
    fundingKBps: "100",
    fundingMaxPremiumBps: "500",
    fundingMaxE9PerSlot: "1000",   // v12.18 e9 units; see prodInitMarketArgs for math
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
//     100 000 slots ≈ 11 hours. Program ceiling is `max_accrual_dt_slots`
//     (10 000 000 in v12.18, raised from 100 000). Must exceed
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
//     (admin / hyperp-mark / insurance / insurance-operator) form the
//     "traders-are-rug-proof" configuration the program's guard
//     comments describe. (v12.20: close_authority was merged into
//     admin; CloseSlab is now gated on header.admin.)
//
//   maxCrankStalenessSlots:
//     500 slots (≈3 min 20 s). Tight enough to keep margin checks
//     honest, loose enough that keeper backoff / fee-market spikes
//     don't trigger spurious risk-reduction mode.
//
//   newAccountFee / min_nonzero_*_req:
//     $10 init fee + $0.10 MM / $0.20 IM. Keeps dust accounts out —
//     each InitUser irrevocably transfers $10 to the insurance fund,
//     so bot-farming opens is uneconomic. Matches the $5/day fee
//     (account has ≥ 2 days survival with no trading activity).
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

    // --- Risk params ---
    // v12.21 §14.1: h_max <= permissionlessResolveStaleSlots <= 100.
    hMin:                    "10",                // ~4 s warmup floor
    hMax:                    "100",               // ~40 s warmup ceiling (= perm-resolve)
    maintenanceMarginBps:    "500",              // 5 % MM
    initialMarginBps:        "1000",             // 10 % IM → 10× max leverage
    tradingFeeBps:           "10",               // 0.1 %
    maxAccounts:             "4096",             // full capacity
    // v12.20: new-account init fee (insurance-destined). Acts as dust gate +
    // insurance top-up on each new Account. $10 matches the old
    // min_initial_deposit floor so bot-farming opening/closing empty
    // accounts is uneconomic.
    newAccountFee:           "10000000",         // $10 in µUSDC
    // v12.21: discarded by wrapper but still on the wire. Send 0 placeholder.
    maxCrankStalenessSlots:  "0",
    liquidationFeeBps:       "100",              // 1 % liquidation fee
    liquidationFeeCap:       "1000000000",       // $1 000 max per liquidation
    resolvePriceDeviationBps:"500",              // 5 % max settlement-price deviation
    minLiquidationAbs:       "1000000",          // $1 min liquidation size
    minNonzeroMmReq:         "100000",           // $0.10 min MM req
    minNonzeroImReq:         "200000",           // $0.20 min IM req
    // v12.21: per-slot price-move cap. Solvency envelope (§1.4):
    //   cap × 100 + funding_part + liq_fee_bps <= maintenance_margin_bps
    // 2 bps/slot × 100 = 200 bps headroom out of 500 bps MM, leaves 200
    // bps for liquidation_fee_bps + funding_part. Engine rejects accrue
    // calls if observed price moves > cap × dt.
    maxPriceMoveBpsPerSlot:  "2",

    // --- Extended tail ---
    // Insurance withdrawal: disabled by default. Set insurance_authority
    // under UpdateAuthority once operational rhythm is established.
    insuranceWithdrawMaxBps:         0,
    insuranceWithdrawCooldownSlots:  "0",

    // v12.21 hard cap: permissionlessResolveStaleSlots <= MAX_ACCRUAL_DT_SLOTS = 100.
    // 100 slots ≈ 40 sec at 400 ms/slot — far tighter than the prior 48 h window,
    // because the wrapper now requires a crank every <100 slots OR the market
    // becomes resolvable. Operationally: a continuous (sub-40s) cranker is required.
    permissionlessResolveStaleSlots: "100",
    forceCloseDelaySlots:            "200",      // 80 sec post-resolve before force-close

    // Funding — v12.18 API takes engine-native e9 (parts-per-billion per
    // slot), NOT bps. Engine global ceiling is 10_000 e9/slot (~0.22%/day
    // at sustained max; realistic perp markets run 3-5 orders of magnitude
    // below this). Wrapper default is 1_000 e9/slot (~0.022%/day cap,
    // non-binding on any normal market).
    fundingHorizonSlots:  "7200",    // ~48 min EWMA
    fundingKBps:          "100",     // 1× multiplier
    fundingMaxPremiumBps: "500",     // 5 % premium cap
    fundingMaxE9PerSlot:  "1000",    // 1e-6/slot ≈ 0.022%/day cap (envelope, not rate)

    // Fee-weighted EWMA on trade marks
    markMinFee: "0",

    ...overrides,
  };
}
