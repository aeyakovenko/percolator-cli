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

## Related Fix: `5f5213c` warmup budget double-subtraction

Commit `5f5213c` in `percolator` core ("Fix warmup budget double-subtraction deadlock") fixes a related bug where `warmup_budget_remaining()` double-subtracted `W+` (warmed positive total), causing the budget to hit 0 while raw insurance was still available.

**Old (buggy):** `budget = W- + insurance_spendable_unreserved() - W+`
  - `unreserved = raw - reserved`, where `reserved = min(W+ - W-, raw)`
  - When `W+ > W-`: `reserved = W+ - W-`, so `unreserved = raw - (W+ - W-)`, then `budget = W- + raw - W+ + W- - W+ = 2*W- + raw - 2*W+` -- double-subtracts W+

**New (fixed):** `budget = W- + insurance_spendable_raw() - W+`

### Does the fix resolve this issue?

**No.** The fix was redeployed to devnet and tested. Two separate problems prevent recovery:

1. **The budget bug does not trigger in this scenario.** In the post-crash state, `W- = 39.34 SOL >> W+ = 3.75 SOL`. Since `W+ < W-`, `reserved = 0` and the old formula gives the same result as the new one. The budget bug only manifests when `W+ > W-`.

2. **Warmup is paused by risk-reduction mode.** The engine field `warmup.paused = true` was set when risk-reduction mode activated during the crash. Even with a correct budget of 35.73 SOL (`W- + raw - W+ = 39.34 + 0.14 - 3.75`), the crank skips warmup processing entirely while paused.

3. **Risk-reduction mode blocks all new trades.** When the stress test was rerun on the already-damaged market, all 5 trade attempts failed. No new positions can be opened, so no new fees can generate, and the deadlock persists.

### What the fix does help with

The fix prevents a different deadlock scenario: during normal operations (not risk-reduction mode), if positive PnL warmup (`W+`) exceeds negative PnL warmup (`W-`), the old code would stall warmup prematurely even when the insurance fund had available budget. This is important for day-to-day market health.

## Recovery Options

Available admin instructions that could help:

| Instruction | Effect |
|------------|--------|
| `TopUpInsurance` (tag 9) | Inject SOL into insurance fund -- could rebuild surplus |
| `SetRiskThreshold` (tag 11) | Adjust risk-reduction threshold |
| `UpdateConfig` (tag 14) | Update threshold parameters |

There is **no admin instruction** to directly clear `riskReductionOnly` or reset `lossAccum`. The only path to recovery is growing the insurance fund above the threshold, which requires either admin injection via `TopUpInsurance` or a protocol upgrade.

## Resolution: PR #15 — Automatic Stranded Funds Recovery

**Status: RESOLVED**

PR #15 in `percolator` core ("Stranded funds detection and automatic insurance recovery", commits `9e15fcc`, `61b08dc`, merged `bb9474e`) adds `recover_stranded_to_insurance()` which runs automatically during `keeper_crank`. The recovery triggers when all three conditions are met:

1. `risk_reduction_only == true`
2. `loss_accum > 0`
3. Total open interest == 0 (all positions closed/liquidated)

### Recovery mechanism

1. **Haircut phantom PnL**: All accounts with positive realized PnL have it zeroed out. The LP's 58.17 SOL phantom PnL (which was never backed by withdrawable funds) is eliminated.
2. **Clear loss accumulator**: `lossAccum` is reset to 0.
3. **Move stranded funds to insurance**: All vault surplus (vault - total_capital) is transferred to the insurance fund balance.
4. **Exit risk-reduction mode**: `riskReductionOnly` set to false, warmup unpaused.

### Verified on devnet

After rebuilding with `bb9474e` and redeploying, a single keeper crank triggered the recovery:

| Field | Before | After |
|-------|--------|-------|
| `engine.lossAccum` | 24.14 SOL | 0 SOL |
| `engine.riskReductionOnly` | true | false |
| `engine.insuranceFund.balance` | 0.14 SOL | 34.17 SOL |
| `engine.warmup.paused` | true | false |
| `account[0].pnl.realized` | 58.17 SOL | 0 SOL |
| `account[0].capital` | 8.18 SOL | 8.18 SOL (unchanged) |
| `solvency.stranded` | 36.65 SOL | 2.62 SOL* |

\* Residual 2.62 SOL is dust from GC'd trader accounts (new account fees etc). The LP's capital is fully withdrawable and the market is operational again.

### Impact

The fix correctly handles the deadlock by recognizing that when all positions are closed and losses have been socialized, phantom PnL is meaningless — those profits can never be realized because the counterparties are gone. The insurance fund absorbs the stranded funds, which is the appropriate destination since insurance exists to cover exactly these kinds of gap-risk events.

## Severity

~~Medium -- no funds are lost or stolen, but they can become permanently inaccessible without admin intervention after a gap-risk event that exhausts the insurance fund.~~

**Resolved** — PR #15 (`bb9474e`) adds automatic recovery. No admin intervention required. The keeper crank detects the stranded state and recovers funds to insurance automatically.

## Corner Case Stress Test

Comprehensive stress test: `scripts/stress-corner-cases.ts`

Tests four scenarios to verify recovery robustness and edge cases:

| # | Scenario | What it tests |
|---|----------|---------------|
| 1 | Baseline Recovery | Full gap-risk crash (50% down, 5 LONG traders at ~9.6x), verify PR #15 auto-recovery clears lossAccum, exits risk-reduction, zeros phantom PnL, replenishes insurance |
| 2 | Double Crash | Recover from scenario 1, crash again (50%), then 80% to overwhelm insurance — verifies repeat recovery cycles work |
| 3 | LP Underwater | Traders open SHORT (LP goes LONG), crash DOWN — tests the opposite crash direction where LP is the losing side |
| 4 | Manual Top-Up | Small crash triggers risk-reduction, then admin `topUpInsurance` instead of auto-recovery — tests the admin escape hatch |

Conservation invariant checked after every state transition: `vault >= sum(capital) + insurance` (slack bounded by 4096 lamports).

Run: `npx tsx scripts/stress-corner-cases.ts`

### Corner Case Findings

#### Finding 1: Auto-recovery triggers within 1-2 cranks

When PR #15 conditions are met (riskReduction=true, lossAccum>0, totalOI=0), recovery completes within a single crank cycle. Observed in stress test: crank 1 shows `lossAccum=4.45, ins=0.02` (socialization), crank 2 shows `lossAccum=0, ins=43.96` (fully recovered). The recovery is immediate once conditions are satisfied.

#### Finding 2: Large insurance fund prevents socialization entirely

When the insurance fund is large (e.g., 34+ SOL from prior recovery), a 50% crash on 10 SOL total trader exposure is absorbed entirely by insurance. No socialization occurs, no risk-reduction activates. The insurance fund dropped from ~36 SOL to ~17 SOL absorbing bad debt — this is the intended happy path.

#### Finding 3: LP profitable position blocks auto-recovery

**Severity: Low (workaround exists)**

When the LP has a profitable position (e.g., SHORT during a crash), all traders are liquidated but the LP's counterparty position persists. This keeps `totalOI > 0`, which blocks PR #15's auto-recovery (requires `totalOI == 0`).

Observed in 80% crash scenario:
- LP SHORT(-10T), 5 traders liquidated
- `lossAccum = 11.77 SOL`, `riskReductionOnly = true`
- `totalOI = 10T` (LP position), auto-recovery blocked

**Workaround**: Admin calls `topUpInsurance` with enough to cover lossAccum + threshold. This exits risk-reduction mode via the `exit_risk_reduction_only_mode_if_safe` path, which does NOT require `totalOI == 0`. Verified working in scenario 4.

**Recommendation**: Consider extending `recover_stranded_to_insurance()` to handle the case where the only remaining OI is from the LP's counterparty position. When all non-LP accounts are liquidated/closed, the LP's phantom position has no counterparty and should be closeable.

#### Finding 4: LP survives -40% crash while LONG (not liquidated)

When LP is on the losing side (LONG position, price crashes 40%), the LP survives with sufficient capital:
- LP capital: 18.58 SOL, PnL: -15.19 SOL, effective equity: 3.39 SOL
- Not liquidated, not force-closed, no risk-reduction triggered
- Traders (SHORT, profitable) successfully withdrew their profits

This confirms the LP's capital buffer is working as designed for moderate crashes.

#### Finding 5: Conservation invariant holds throughout all scenarios

`vault >= sum(capital) + insurance` holds in every state transition across all test runs. The vault surplus (dust) grows over time from GC'd trader accounts — residual from `new_account_fee` payments. After many cycles: ~20 SOL dust accumulated. This is expected and non-recoverable by design.

#### Finding 6: Risk-reduction mode blocks all new trades

When the market enters risk-reduction mode, all trade attempts fail (both LONG and SHORT). This is correct behavior — risk-reduction prevents new exposure. Admin `topUpInsurance` is the only way to resume trading when auto-recovery is blocked by LP position (Finding 3).

## Bug: Recovery Over-Haircut (LP Legitimate Profit Confiscated)

**Status: FIXED** — Verified on devnet after deploying core commit `19cd5de`.

**Severity: High** — LP's legitimate profit was confiscated into insurance during recovery.

### Summary

`recover_stranded_to_insurance()` computes `total_needed = stranded + loss_accum ≈ Σpnl`, then `haircut = min(total_needed, total_positive_pnl) = total_positive_pnl`. This wipes **100%** of the LP's PnL, including the legitimate profit portion (`pnl - loss_accum`) that the LP actually earned from the crash.

### Evidence from stress test run 3

```
Crank 1: lossAccum=37.450646, ins=0.005021, rr=true   ← socialization
Crank 2: lossAccum=0.000000,  ins=10.922609, rr=false  ← recovery wiped LP PnL to 0
```

- LP PnL before recovery: ~48 SOL
- LossAccum (socialized portion): ~37.45 SOL
- Expected LP PnL after recovery: `48 - 37.45 ≈ 10.55 SOL`
- Actual LP PnL after recovery: **0 SOL**
- Confiscated legitimate profit: **~10.55 SOL** → sent to insurance

### Root cause

In `recover_stranded_to_insurance()`:

1. `stranded = vault - total_capital - insurance` (funds belonging to no one)
2. `total_needed = stranded + loss_accum` — this approximates `Σ positive_pnl` because the stranded funds are the vault surplus created by phantom PnL
3. `haircut = min(total_needed, total_positive_pnl)` — since `total_needed ≈ total_positive_pnl`, this equals `total_positive_pnl`
4. Each account's positive PnL is zeroed: `acc.pnl = 0`

The haircut eliminates **all** positive PnL, but it should only eliminate the **socialized loss portion** (`loss_accum`). The difference (`pnl - loss_accum`) is legitimate profit the LP earned from being on the winning side of the crash.

### Correct behavior

The recovery should:
- Haircut only the `loss_accum` portion from positive PnL holders (proportionally)
- Leave `pnl - loss_accum` as legitimate, withdrawable profit
- Move only the `loss_accum`-equivalent stranded amount to insurance

### Reproduction

Script: `scripts/bug-recovery-overhaircut.ts`

```
npx tsx scripts/bug-recovery-overhaircut.ts
```

Steps:
1. Reset market to clean state (LP flat)
2. Setup: 5 traders (2 SOL each) + LP boost (10 SOL), all traders LONG 2T units
3. Gap price 50% down without cranking
4. Crank once — liquidation cascade + socialization (lossAccum > 0)
5. Capture pre-recovery state: LP PnL, lossAccum
6. Crank once more — recovery triggers, zeroes LP PnL
7. Report: expected vs actual LP PnL, confiscated profit amount

### Fix verification

Core commit `19cd5de` ("Fix 3 design flaws in stranded funds recovery") changes the haircut from `min(stranded + loss_accum, total_positive_pnl)` to `min(loss_accum, total_positive_pnl)`. Deployed to devnet and verified:

| Metric | Before fix | After fix |
|--------|-----------|-----------|
| Pre-recovery LP PnL | 48.38 SOL | 57.85 SOL |
| LossAccum | 36.40 SOL | 34.15 SOL |
| Expected LP PnL | 11.98 SOL | 23.70 SOL |
| **Actual LP PnL** | **0.00 SOL** | **23.699180 SOL** |
| Confiscated profit | 11.98 SOL | **0.00 SOL** |

LP now retains exactly `pnl - loss_accum` of legitimate profit after recovery.
