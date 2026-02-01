# Stranded Vault Funds After Socialized Loss Event

## Summary

After a gap-risk scenario (oracle price gaps past liquidation levels before the crank processes), the insurance fund is exhausted and losses are socialized. The winning counterparty (LP) accumulates large realized PnL that cannot be withdrawn due to the warmup mechanism and depleted insurance surplus. This leaves a significant portion of vault funds permanently stranded with no viable recovery path under current market conditions.

## Reproduction

Stress test: `scripts/stress-worst-case.ts`

1. 5 traders deposit 2 SOL each, open near-max leverage LONG positions (~9.6x, 2T units each)
2. LP boosted with 10 SOL to absorb counterparty SHORT exposure
3. Oracle price gapped 50% down in one step WITHOUT cranking (simulates delayed crank / gap risk)
4. Cranks then process the liquidation cascade

## Observed State After Event

| Metric | Value |
|--------|-------|
| Vault balance | 43.15 SOL |
| LP capital (withdrawable) | 6.36 SOL |
| LP realized PnL (paper) | 58.17 SOL |
| LP reservedPnl (warmed) | 0 |
| LP warmupSlopePerStep | 24,823,400 (~0.025 SOL/step) |
| Insurance fund | 0.14 SOL |
| Insurance surplus | 0.04 SOL |
| Socialized losses (lossAccum) | 24.14 SOL |
| Risk-reduction mode | true |
| Stranded vault funds | 36.65 SOL |
| New liquidations | 5 |
| New force closes | 1 |

## The Problem

After the event, the vault holds 43.15 SOL but only 6.50 SOL is claimable (6.36 LP capital + 0.14 insurance). The remaining **36.65 SOL is stranded** -- it belongs to nobody:

- **Traders are gone**: All 5 were liquidated with negative equity. Their capital was seized but insufficient to cover their losses.
- **LP can't access its PnL**: The LP earned 58.17 SOL in realized PnL, but `reservedPnl = 0` (none warmed up). The warmup mechanism gates PnL withdrawal through insurance surplus, which is nearly zero (0.04 SOL).
- **Insurance is depleted**: Drained from 1.64 SOL to 0.14 SOL absorbing bad debt before socializing the remainder.
- **Market is frozen**: Risk-reduction-only mode prevents new trading, which prevents fee generation, which prevents insurance from rebuilding.

## Recovery Path Analysis

The LP's "real" PnL after the socialized haircut is `58.17 - 24.14 = 34.03 SOL`. The vault has enough tokens (43.15) to eventually pay this. But the warmup mechanism requires insurance surplus to grow, and the market is frozen.

**Deadlock**: No new trades -> no fees -> no insurance growth -> no warmup budget -> LP can't withdraw PnL -> funds stay stranded.

The only escape would be:
1. Admin intervention to disable risk-reduction mode or manually settle PnL
2. External insurance fund injection
3. A protocol upgrade to handle this edge case

## Correctness Assessment

The protocol handled the crisis correctly in several ways:

- Insurance was drained first before socializing losses
- `lossAccum` correctly tracks the socialized haircut amount
- Risk-reduction mode activated to prevent further damage
- LP cannot withdraw phantom PnL (prevents insolvency)
- Vault token balance always >= capital + insurance (no token-level insolvency)

The issue is not a solvency bug but a **liveness problem**: funds are safe but permanently inaccessible under the current state machine.

## Affected Fields

- `engine.lossAccum`: 24,141,247,293 lamports (24.14 SOL)
- `engine.riskReductionOnly`: true
- `engine.insuranceFund.balance`: 139,542,642 lamports (0.14 SOL)
- `account[0].pnl`: 58,170,739,754 lamports (58.17 SOL)
- `account[0].reservedPnl`: 0
- `account[0].capital`: 6,356,015,531 lamports (6.36 SOL)
- `engine.vault`: 43,150,007,727 lamports (43.15 SOL)

## Related Fix

Commit `5f5213c` in `percolator` core ("Fix warmup budget double-subtraction deadlock") fixes a related bug where `warmup_budget_remaining()` double-subtracted `W+` (warmed positive total), causing the budget to hit 0 while raw insurance was still available. The fix uses `insurance_spendable_raw()` instead of `insurance_spendable_unreserved()`.

However, this fix addresses the budget **calculation** bug (which manifests when `W+ > W-`). The broader issue documented here involves risk-reduction mode **pausing** warmup entirely after a crash. In our stress test, `W- >> W+` (39.34 vs 3.75 SOL), so the double-subtraction bug does not trigger. The stranded funds result from the warmup being paused in risk-reduction mode, which is a separate mechanism.

## Severity

Medium -- no funds are lost or stolen, but they can become permanently inaccessible without admin intervention after a gap-risk event that exhausts the insurance fund.
