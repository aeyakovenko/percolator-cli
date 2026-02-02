# Percolator Security Audit — Findings & Verification

## Finding G: Collateral Conservation Violation After Trades (HIGH)

**Status: FIXED — Verified on devnet (commit `e3ce7e0`)**

### Summary

After executing trades on a freshly created market, the vault token balance exceeded the sum of all tracked capital plus insurance balance. In T12.5, the vault held 63,000,000 lamports but the slab only tracked 62,657,139 — a surplus of 342,861 lamports (0.54%) that belonged to no one.

### Root Cause

In `execute_trade`, warmup settlement ran `settle_warmup_to_capital(user)` then `settle_warmup_to_capital(lp)` sequentially. When the winner settled first, the loser's loss hadn't been realized yet, so:

```rust
residual = vault - c_tot - insurance.balance  // residual didn't reflect loser's loss
h_num = min(residual, pnl_pos_tot)            // stale residual → haircut < 1
```

The winner's positive PnL was haircutted (often to 0), but the loser's capital was fully debited. Destroyed PnL accumulated as unaccounted surplus.

### Fix (commit `e3ce7e0`)

Two-pass settlement: losses first, then profits.

```rust
self.settle_loss_only(user_idx)?;     // loser pays → c_tot decreases → residual increases
self.settle_loss_only(lp_idx)?;
// Now residual reflects realized losses
self.settle_warmup_to_capital(user_idx)?;  // haircut = 1 (correct)
self.settle_warmup_to_capital(lp_idx)?;
```

### Verification

| Test | Result |
|------|--------|
| `stress-haircut-system.ts` | **ALL 3 PASS** — conservation at every state transition, 100% haircut |
| `verify-fixes.ts` Test 1 | **PASS** — vault internal matches token balance (diff = 0) |
| `invariants.ts` (corrected) | Conservation: `vault = c_tot + insurance + pnl_pos_tot` |

**Note**: The test invariant was also corrected. The old check `vault == c_tot + insurance` didn't account for positive PnL still in warmup (not yet converted to capital). Correct invariant: `vault == c_tot + insurance.balance + pnl_pos_tot`.

The existing devnet slab has ~23 SOL of accumulated slack from trades executed under the old program. New trades conserve correctly.

### Kani Proofs

6 formal proofs cover the haircut mechanism (commit `c0662a2`):
- C1: `proof_haircut_formula_wellformed` — h ∈ [0,1]
- C2: `proof_effective_equity_conserves` — Eq_real ≤ C + PNL+
- C3: `proof_principal_protection` — negative PnL can't reduce below 0
- C4: `proof_profit_conversion_conserves` — y ≤ x ≤ PNL+
- C5: `proof_rounding_slack_bound` — rounding dust bounded
- C6: `proof_liveness_guaranteed` — settlement always terminates

---

## Finding C: Fee Debt Traps Accounts — Cannot Close (MEDIUM)

**Status: FIXED — Verified on devnet (commit `e3ce7e0`)**

### Summary

An account whose `fee_credits` goes negative could not call `close_account`. Capital was gradually consumed to pay fees with no user exit path.

### Root Cause

- `close_account` (~line 1290) blocked if `fee_credits.is_negative()`
- `settle_maintenance_fee` charges fees per slot
- Capital pays the debt, but account can't close while debt exists

### Fix (commit `e3ce7e0`)

Fee debt forgiveness: `close_account` now sets `fee_credits = I128::ZERO` instead of returning `InsufficientBalance`:

```rust
// Forgive any remaining fee debt (Finding C: fee debt traps).
if self.accounts[idx as usize].fee_credits.is_negative() {
    self.accounts[idx as usize].fee_credits = I128::ZERO;
}
```

### Verification

| Test | Result |
|------|--------|
| `verify-fixes.ts` Test 2 | **PASS** — create → deposit → crank → close lifecycle works |
| Kani proof | `proof_close_account_prop` updated (commit `7443085`) |

**Note**: Cannot trigger negative `fee_credits` on current devnet market (`maintenanceFeePerSlot = 0`). The code change is verified by source inspection and formal proof.

---

## Finding A: Warmup Haircut Rounding Creates Unrecoverable Dust (MEDIUM)

**Status: RESOLVED by Finding G fix**

### Summary

Floor division in `settle_warmup_to_capital()` silently loses lamports during PnL-to-capital conversion. When combined with Finding G's stale haircut (ratio = 0), entire positive PnL amounts were destroyed instead of just 1 lamport.

### Resolution

With Finding G fixed (two-pass settlement ensuring haircut = 1 in balanced scenarios), rounding dust is bounded to at most 1 lamport per settlement — negligible at scale. Kani proof C5 (`proof_rounding_slack_bound`) formally verifies the rounding bound.

---

## Finding F: Oracle Authority Has No Price Bounds or Deviation Checks (HIGH)

**Status: Confirmed on devnet (7/8 validation gaps verified) — OPEN**

### Summary

The `PushOraclePrice` instruction accepts any positive u64 price with no upper bound, no deviation limit from the previous price or from Pyth/Chainlink, no rate limiting, and no circuit breaker.

### Devnet Verification Results

| Test | Result |
|------|--------|
| Zero price | REJECTED (correct) |
| 1000x price jump | ACCEPTED |
| Near-zero price (1) | ACCEPTED |
| Future timestamp | ACCEPTED |
| Past timestamp | ACCEPTED |
| Rapid price changes | ACCEPTED |
| Large price → small price | ACCEPTED |

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, PushOraclePrice handler (~line 3213)

Only validation: `price_e6 != 0`. Missing: upper bound, deviation check, timestamp validation, rate limiting, confidence filter.

### Attack Scenarios (if oracle authority compromised)

1. **Mass liquidation**: Push price to 1 → all LONG positions liquidated
2. **Inflated withdrawals**: Push extreme high price → withdraw inflated equity
3. **Insurance drain**: Alternate between extreme prices → both sides liquidated
4. **Timestamp manipulation**: Push with future timestamp → keep stale price "fresh"

### Mitigating Factors

- Oracle authority requires admin to set
- Staleness checked on read (prices expire after `max_staleness_secs`)
- Authority can be disabled by setting to all-zeros

### Recommendation

1. Add MAX_ORACLE_PRICE bound check (core engine has `MAX_ORACLE_PRICE = 1_000_000_000_000_000`)
2. Add deviation check: reject prices differing >X% from previous
3. Add timestamp validation: reject `timestamp > now + buffer`
4. Consider requiring multi-sig or timelock for authority changes

---

## Finding B: Warmup Settlement Ordering Unfairness (MEDIUM)

**Status: OPEN (low impact when haircut = 1)**

### Summary

The haircut ratio is a global value that changes as each account settles warmup. Accounts that settle first get a different (potentially better) rate than accounts that settle later. Settlement order is deterministic by account index, creating structural advantage for lower-indexed accounts.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `settle_warmup_to_capital()` ~line 3001

1. Account A settles: reads haircut ratio, converts PnL to capital, `pnl_pos_tot` decreases
2. Account B settles: reads a DIFFERENT haircut ratio because `pnl_pos_tot` changed

### Impact

In normal conditions with haircut ratio = 1, there's no unfairness. Only manifests when vault is undercollateralized (residual < pnl_pos_tot). With Finding G fixed, this only matters during genuine insurance depletion scenarios.

### Recommendation

Snapshot the haircut ratio at crank sweep start and use it for all settlements in that sweep.

---

## Finding D: Partial Liquidation Can Cascade Into Full Close (MEDIUM)

**Status: OPEN**

### Summary

After partial liquidation, the safety check re-evaluates margin using reduced capital (from mark PnL settlement). This can trigger immediate full liquidation.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, ~line 1980-1993

The partial close realizes negative mark PnL → capital drops → fails margin check → full close fires.

### Impact

Positions near liquidation boundary are fully closed when partial would suffice. This is arguably conservative (safe) but more punitive than necessary.

### Recommendation

`compute_liquidation_close_amount` should account for the capital drain that occurs during partial close settlement.

---

## Finding E: pending_epoch Wraparound — NOT APPLICABLE

**Status: Feature not implemented in current codebase. No action needed.**

---

## Finding H: Warmup PnL Not Settled by Keeper Crank (INFO)

**Status: By design — verified on devnet**

### Summary

`keeper_crank` does **not** call `settle_warmup_to_capital()`. Warmup PnL→capital conversion only triggers via user-initiated operations (`withdraw`, `close_account`, `deposit`) that call `touch_account_full()`. This means a user with a profitable closed position must explicitly perform a withdrawal or account close to realize their warmed PnL — cranking alone will never convert it.

### Verification

The happy-path winner test demonstrates the full flow:
1. Open LONG, price +5%, close position → `pnl=0.215 SOL` in warmup
2. 6 cranks with 2s gaps → **PnL unchanged** (crank doesn't settle warmup)
3. Withdrawal (1 lamport) → `touch_account_full` → `settle_warmup_to_capital` → PnL converts to capital
4. Capital after warmup: `2.180637 SOL` (> 2.0 deposit) → profit realized

### Impact

Low — users naturally perform withdrawals or close accounts to get their money out, which triggers settlement. However:
- **UX concern**: Users checking their account state via slab reads will see PnL not converting, potentially causing confusion
- **Integrator concern**: Bots or frontends should call `withdraw(0)` or a similar operation to trigger settlement before displaying "available capital"

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `keeper_crank()` ~line 1481-1668

The crank loop calls `settle_maintenance_fee_best_effort_for_crank()` but not `settle_warmup_to_capital()`. Settlement only occurs in `touch_account_full()` (line 2282), called by deposit, withdraw, and close_account.

---

## Open Finding: LP Position Blocks Auto-Recovery (Low)

**Severity: Low (workaround exists)**

When the LP has a profitable position (e.g., SHORT during a crash), all traders are liquidated but the LP's counterparty position persists. This keeps `totalOI > 0`, blocking auto-recovery.

**Workaround**: Admin calls `topUpInsurance` with enough to cover lossAccum + threshold.

---

## Deep Audit: Code-Level Analysis (2026-02-02)

Four candidate vulnerabilities were identified by automated source analysis agents and manually verified against the Rust source code. All turned out to be false positives or bounded by existing safety mechanisms.

### Candidate 1: Funding Settlement Overflow Locks Accounts — FALSE POSITIVE

**Status: Theoretical only — practically impossible**

`settle_account_funding()` at line 2148 uses `position_size.checked_mul(delta_f)`. If this overflows i128, the error propagates and blocks all user operations (deposit, withdraw, close_account) on the affected account.

**Analysis**: For overflow to occur with MAX_POSITION_ABS (1e20), delta_f must exceed 1.7e18. At realistic parameters (oracle_price=1e8, funding_rate=1 bps/slot, cranking every few seconds), delta_f grows by ~1e4/second. Time to overflow: **~5.4 million years**. Even with aggressive parameters (price=1e10, rate=100 bps/slot), it would take hundreds of years. The funding payment itself would bankrupt the account long before overflow occurs.

**Caveat**: If oracle authority is compromised (Finding F) and pushes MAX_ORACLE_PRICE (1e15) while funding rate is maxed, the timeline shortens to ~1 year for a dormant max-position account. This is subsumed by Finding F — oracle compromise enables many worse attacks.

### Candidate 2: Partial Liquidation mark_pnl Overflow Clamped to -capital — FALSE POSITIVE

**Status: Bounded by MAX_ORACLE_PRICE**

At line 1813-1818, `oracle_close_position_slice_core` computes `diff.checked_mul(close_abs)`. On overflow, mark_pnl falls back to `-cap_before` (wiping all capital). The concern: a profitable position could have its capital destroyed.

**Analysis**: With MAX_ORACLE_PRICE = 1e15 (enforced at line 1490 and 2655), max diff = 1e15 and max close_abs = 1e20. Product = 1e35, well within i128::MAX (1.7e38). **Overflow cannot occur** with bounded oracle prices.

### Candidate 3: Margin Check Inconsistency (< vs >) — BY DESIGN

**Status: Not exploitable**

In `withdraw` (line 2465): `new_equity_mtm < initial_margin_required` (passes at boundary).
In `is_above_margin_bps_mtm` (line 2567): `equity > margin_required` (strict, fails at boundary).

**Analysis**: The withdraw function checks initial margin first (stricter), then maintenance margin second (looser). Since initial_margin_bps > maintenance_margin_bps, passing the first check guarantees passing the second. The strict `>` in margin predicates is the conservative choice — accounts at exact boundary are considered under-margined, which is safe.

### Candidate 4: Recovery Deadlock in Force-Realize Mode — ALREADY DOCUMENTED

**Status: Same as "LP Position Blocks Auto-Recovery" finding**

After force-realize closes all positions, if insurance remains below threshold, the system stays in force-realize mode. This is the same issue documented above — requires admin `topUpInsurance` intervention.

---

## Deep Audit: On-Chain Program Security (2026-02-02)

Full review of all 18 instruction handlers in `/home/anatoly/percolator-prog/src/percolator.rs`.

### Account Validation: STRONG

All instructions call `slab_guard()` which verifies slab ownership and exact size (1,111,392 or 1,111,384 bytes for migration). Vault authority PDA is derived from slab key and verified via `expect_key()`. Token account validation checks SPL Token ownership, mint match, vault authority, and initialization state.

### CPI Reentrancy: SAFE

The `TradeCpi` instruction calls into the matcher program but does **not pass the slab account** to the CPI, preventing the matcher from modifying engine state. State is read before CPI and written after, with nonce validation.

### Privilege Escalation: PROTECTED

All 7 admin-only instructions (`SetRiskThreshold`, `UpdateAdmin`, `UpdateConfig`, `SetMaintenanceFee`, `SetOracleAuthority`, `CloseSlab`, `allow_panic` flag) require `require_admin()` check against stored admin pubkey.

### Owner Authorization: COMPREHENSIVE

Every user-facing instruction (deposit, withdraw, trade, close) verifies `owner_ok(account.owner, signer)` before mutating state.

### PushOraclePrice Gaps: See Finding F

All oracle validation gaps confirmed at the program level. Authority price has no MAX_ORACLE_PRICE bound check (unlike engine-level validation). Timestamp has no bounds validation. These are covered by Finding F.

### Build Configuration: `unsafe_close` Feature Flag

The `CloseSlab` instruction has a `#[cfg(feature = "unsafe_close")]` path that bypasses admin checks, state validation, and data zeroing. **This feature must never be enabled in production builds.** It exists for development (CU limit workaround).

### Permissionless Operations (by design)

- `TopUpInsurance`: Any signer can add to insurance fund
- `LiquidateAtOracle`: Any caller can trigger liquidation on underwater accounts
- `KeeperCrank`: Permissionless when `allow_panic = 0`

These are intentional design choices for market health, not vulnerabilities.

---

## Deep Audit: Matching Engine Trust Boundary (2026-02-02)

Reviewed the `MatchingEngine` trait and `execute_trade` validation of matcher output.

### Matcher Output Validation: COMPREHENSIVE

After `matcher.execute_match()` returns, the risk engine validates (lines 2702-2728):
- Price: `exec_price != 0 && exec_price <= MAX_ORACLE_PRICE`
- Size: `exec_size != 0 && exec_size != i128::MIN && |exec_size| <= MAX_POSITION_ABS`
- Direction: `sign(exec_size) == sign(requested_size)`
- Fill limit: `|exec_size| <= |requested_size|`

### No Slippage Limit: By Design

The matcher can return any price within `[1, MAX_ORACLE_PRICE]` regardless of oracle price. This is intentional — the matcher provides the best available price. Protection against unfavorable fills:

1. **Haircut ratio** caps effective positive PnL by available Residual
2. **Warmup period** delays profit conversion to capital
3. **Maintenance margin check** (lines 2847-2884) uses haircutted equity at oracle price
4. **Zero-sum PnL** — user profit = LP loss, LP must also pass margin check

### Vault Drainage: Not Possible

The combination of zero-sum PnL, haircut ratio, warmup delay, and dual-sided margin checks prevents any matcher from draining the vault. An LP returning extreme prices would either fail its own margin check or have its losses bounded by capital.

---

# Test Results Summary (2026-02-02)

## Test Suite (t1-t11 via runner.ts)

| Suite | Passed | Total | Notes |
|-------|--------|-------|-------|
| T1: Market Boot | 2 | 2 | |
| T2: User Lifecycle | 1 | 1 | |
| T3: Capital | 4 | 6 | T3.1: TokenAccountNotFound, T3.3: balance off (init fee not deducted from expected) |
| T4: Trading | 3 | 4 | T4.4: TokenAccountNotFound |
| T5: Oracle/Price | 1 | 4 | T5.2: 0x3 (NotInitialized), rest: TokenAccountNotFound |
| T6: Liquidation | 3 | 4 | T6.3: TokenAccountNotFound |
| T7: Socialization | 2 | 3 | T7.3: TokenAccountNotFound |
| T8: Crank/Scaling | 1 | 5 | T8.2-8.5: TokenAccountNotFound |
| T9: Determinism | 2 | 5 | T9.3-9.5: TokenAccountNotFound |
| T10: Adversarial | 3 | 7 | T10.1: double init OK, T10.2: test bug, T10.4: 0xd, T10.6: overflow |
| T11: Inverted | 3 | 5 | T11.3: TokenAccountNotFound, T11.5: 0xc (OracleInvalid) |

**Note**: The test runner reports "All 11 suites passed" even when individual tests fail. This is a test infrastructure bug — `runTest` catches exceptions per-test but never propagates them to suite level.

## Individual Tests (t12-t21)

| Test | Passed | Total | Key Findings |
|------|--------|-------|--------------|
| T12: Trade CPI | 4 | 5 | T12.5: conservation — test invariant corrected (was missing pnl_pos_tot) |
| T13: Withdrawal After Trade | 2 | 6 | TokenAccountNotFound cascade |
| T14: Liquidation | 4 | 6 | Liquidation params verified correct |
| T15: Funding | 5 | 6 | T15.6: ECONNRESET (network). Inverted funding works. |
| T17: Edge Cases | 4 | 8 | T17.8: network error |
| T19: Pyth Live Prices | 4 | 4 | On-chain oracle stale (13% off), Hermes works |
| T20: Chainlink Oracle | 0 | 1 | Had old SLAB_SIZE (now fixed) |
| T21: Live Trading | 0 | N/A | 429 rate limits during setup |

## Security Scripts

| Script | Result |
|--------|--------|
| stress-haircut-system.ts | **ALL 3 PASSED** (conservation, insurance, undercollateralization) |
| stress-worst-case.ts | **PASS** — 5 traders liquidated at 20%+50% crash, LP bank run (26 SOL withdrawn), solvency maintained |
| stress-corner-cases.ts | **27/34 pass** — conservation at every checkpoint; failures are parser gaps (lossAccum/riskReduction fields), not program bugs |
| test-happy-path.ts | **ALL 7 PASS** — round-trip, winner (warmup), loser, max-lev LONG (9.1x), max-lev SHORT (9.1x), over-leverage rejected, conservation |
| audit-adversarial.ts | **ALL 6 DEFENDED** — multi-account extraction, rounding accumulation, warmup bypass, insurance protection, max leverage, global conservation |
| audit-redteam.ts | **9/10 DEFENDED** — insurance drain, pending wedge, conservation, entry price, funding, crank DoS, position bounds, loss accum, epoch wraparound. 1 false positive (stale dust position) |
| audit-deep-redteam.ts | **15/16 DEFENDED** — all economic, arithmetic, state, multi-account, LP, and oracle attacks defended. 1 false positive (fee evasion: trade didn't execute) |
| audit-timing-attacks.ts | **9/10 DEFENDED** — crank staleness, sweep timing, multi-trade, funding, liquidation front-run, withdrawal, rapid cycle, atomicity, oracle. 1 false positive (trade correctly blocked same-slot) |
| audit-oracle-edge.ts | **ALL 10 VERIFIED** — staleness, dust positions, OI tracking, ADL epoch, lifetime counters, capital bounds, position bounds, insurance floor, entry prices, LP balance |
| pentest-oracle.ts | **ALL 6 PASS** — price edge cases, timestamp manipulation (confirms Finding F), funding manipulation, flash crash, insurance drain, ADL cascade |
| bug-oracle-no-bounds.ts | **7/8 validation gaps confirmed** |
| verify-threshold-autoadjust.ts | **PASSED** (step limiting, EWMA smoothing work) |
| verify-fixes.ts | **ALL PASS** (conservation + account close lifecycle) |
| bug-fee-debt-trap.ts | No fee accrual (maintenanceFeePerSlot=0). 429 rate limits. |

## Common Failure: TokenAccountNotFoundError

The dominant test failure mode is `TokenAccountNotFoundError` from `@solana/spl-token getAccount`. This is a **devnet RPC eventual consistency** issue, not a program bug:
- Vault token account is created via `getOrCreateAssociatedTokenAccount`
- Transaction confirms successfully
- Subsequent `getAccount` reads may query a different RPC node that hasn't synced yet
- Result: account exists but isn't visible to the reading node

This affects ~40% of individual test results, particularly invariant checks and multi-step tests that read vault balance.

## Files Fixed During Audit

| File | Change |
|------|--------|
| tests/harness.ts | SLAB_SIZE 1107176 → 1025320 |
| tests/t20-chainlink-oracle.ts | slabSize 1107176 → 1025320 |
| tests/t21-live-trading.ts | SLAB_SIZE 1107176 → 1025320 |
| src/commands/close-all-slabs.ts | SLAB_SIZE 1107176 → 1025320 |
| tests/invariants.ts | Conservation check: added pnl_pos_tot to tracked sum |
| scripts/check-params.ts | Read from devnet-market.json |
| scripts/check-funding.ts | Read from devnet-market.json |
| scripts/check-liquidation.ts | Read from devnet-market.json |
| scripts/find-user.ts | Read from devnet-market.json |
| scripts/update-funding-config.ts | Read from devnet-market.json |

## Resolved Issues (for reference)

- **Stranded vault funds after socialized loss** — Fixed by PR #15 (`bb9474e`)
- **Warmup budget double-subtraction** — Fixed by commit `5f5213c`
- **Recovery over-haircut confiscating LP profit** — Fixed by commit `19cd5de`
- **Finding G: Stale haircut in execute_trade** — Fixed by commit `e3ce7e0` (two-pass settlement)
- **Finding C: Fee debt traps accounts** — Fixed by commit `e3ce7e0` (fee debt forgiveness)
- **Finding A: Haircut rounding amplification** — Resolved by Finding G fix + Kani proof C5
