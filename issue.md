# Percolator Security Audit — Open Issues

## Finding L: Trade Margin Check Uses `maintenance_margin_bps` Instead of `initial_margin_bps` (HIGH)

**Status: OPEN — code-verified AND reproduced on devnet**

### Summary

The `execute_trade()` post-trade collateralization check uses `maintenance_margin_bps` (5%) instead of `initial_margin_bps` (10%), allowing users to open positions at 2x the intended maximum leverage. The withdrawal path correctly uses `initial_margin_bps`.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, lines 2816-2817 and 2837-2838

```rust
// In execute_trade() — user margin check:
let margin_required =
    mul_u128(position_value, self.params.maintenance_margin_bps as u128) / 10_000;
    //                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                       Should be initial_margin_bps

// Same bug for LP margin check at line 2837-2838
```

Compare with `withdraw()` at line 2450-2451 which correctly uses `initial_margin_bps`:
```rust
let initial_margin_required =
    mul_u128(position_notional, self.params.initial_margin_bps as u128) / 10_000;
```

### Concrete Impact (with current devnet params)

- `maintenance_margin_bps` = 500 (5%) → max leverage on trade entry: **20x**
- `initial_margin_bps` = 1000 (10%) → intended max leverage: **10x**
- User deposits 5.01 SOL, opens 100 SOL notional position
- Maintenance margin = 5 SOL → trade passes (5.01 > 5)
- Initial margin would = 10 SOL → trade should be rejected
- Position sits at liquidation boundary immediately after opening
- Any tiny adverse move triggers liquidation

### Impact

- **HIGH**: Users can open positions at 2x intended leverage
- The margin buffer between initial and maintenance margins (designed to prevent immediate liquidation) is bypassed
- Newly opened positions are immediately at risk of liquidation
- Increases systemic risk of cascading liquidations
- No special role required — any user can exploit

### Devnet Evidence

```
$ npx tsx scripts/bug-margin-initial-vs-maintenance.ts

Price: 9719
maintenance_margin_bps: 500 (5%)
initial_margin_bps: 1000 (10%)
Deposited: 0.050000, capital after fees: 0.050000

--- Test 1: Trade at ~15x leverage ---
  Size: 77168432966
  Expected notional: 0.750000 SOL
  At 10% initial margin: need 0.075000 SOL equity
  At 5% maint margin:   need 0.037500 SOL equity
  Actual equity:              0.050000 SOL
  Result: ACCEPTED ← BUG! Should be rejected

--- Test 2: Trade at ~25x leverage ---
  Result: REJECTED (correct — above even 5% maintenance margin)

  FINDING L CONFIRMED: execute_trade() checks maintenance_margin_bps (5%)
  instead of initial_margin_bps (10%). Users can open at 20x leverage.
```

### Recommendation

Change lines 2817 and 2838 to use `self.params.initial_margin_bps` for risk-increasing trades. Consider keeping `maintenance_margin_bps` for risk-reducing trades (partial closes).

---

## Finding M: Funding Rate Retroactive Application Creates Manipulation Window (HIGH)

**Status: OPEN — design-level concern, code-verified**

### Summary

The funding rate is computed from the LP's net position at the instant the permissionless keeper crank is called, then applied retroactively for the entire elapsed period since the last funding accrual. If the LP inventory changed during that period, the retroactive application is incorrect.

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, lines 2555-2570
**File:** `/home/anatoly/percolator/src/percolator.rs`, lines 2073-2119

The crank computes `effective_funding_rate` from current `net_lp_pos` (line 2555-2564), then `accrue_funding` applies `ΔF = price × rate × dt / 10_000` where `dt = now_slot - last_funding_slot` (lines 2079, 2104-2111). The rate is a point-in-time value but `dt` can span hundreds of slots.

### Attack Scenario

1. Slot 100: LP balanced (`net_lp_pos ≈ 0`), last crank at slot 100
2. Slot 100-299: No crank called (attacker avoids cranking)
3. Slot 299: Attacker opens large SHORT position → LP forced net LONG → high positive funding rate
4. Slot 300: Attacker calls permissionless crank. Rate computed from current (skewed) inventory. Applied retroactively for `dt=200` slots
5. Result: all existing LONG holders pay 200 slots worth of high funding, even though LP was balanced for 199/200 slots

The attacker's SHORT position receives the funding payment. After settling, attacker closes the SHORT.

### Mitigating Factors

- `funding_max_bps_per_slot` caps the per-slot rate
- `max_crank_staleness_slots` limits crank staleness (but only enforced on trade/withdraw, not on crank call itself)
- Attacker pays trading fees and mark settlement costs
- Attack requires significant capital (must open large position to skew LP)

### Recommendation

1. Apply funding using a time-weighted average of LP inventory, not point-in-time
2. Or enforce maximum `dt` for funding application (e.g., split large `dt` into multiple intervals)
3. Or enforce that `max_crank_staleness_slots` applies to the funding accrual `dt` as well

---

## Finding K: Zero-Capital "PnL Zombie" Accounts Poison Global Haircut Ratio (CRITICAL)

**Status: FIXED in core engine commit e838580, verified on devnet**

### Summary

An account with 0 capital but positive PnL and a small position becomes a "PnL zombie" that cannot be closed, garbage-collected, or liquidated. Its unbounded positive PnL dominates `pnl_pos_tot`, collapsing the global haircut ratio to near-zero. **All profitable traders on the market lose ~100% of their earned PnL during warmup conversion.**

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`

1. **Mark settlement inflates PnL without bound** (~line 2206): `settle_mark_to_oracle()` adds mark PnL to `account.pnl` and calls `set_pnl()` which updates `pnl_pos_tot`. For a zero-capital account with a position, every favorable price move increases its PnL unboundedly.

2. **No positive PnL write-off** (~line 1910-1911): The engine writes off negative PnL (`if pnl.is_negative() { set_pnl(idx, 0) }`), but positive PnL on a zero-capital account is never written off.

3. **GC blocked by positive PnL** (~line 1393): `garbage_collect_dust()` requires `pnl <= 0` to free an account. Positive PnL prevents GC.

4. **Close blocked by positive PnL** (~line 1300-1301): `close_account()` returns `PnlNotWarmedUp` for positive PnL.

5. **Liquidation blocked by effective equity** (~line 1954): `effective_pos_pnl(pnl)` = `pnl * haircut` makes the account appear well-collateralized.

6. **Warmup never triggers**: `settle_warmup_to_capital()` only fires on user operations. Since nobody interacts with the zombie, its PnL never converts.

### How This State Arises (normal market operation)

1. User opens a position with capital
2. Price moves favorably → PnL becomes positive
3. Maintenance fees drain capital to 0 over time (no active management)
4. Crank continues settling mark_to_oracle → PnL grows unboundedly
5. Account becomes a PnL zombie: can't close, can't GC, can't liquidate

### Fix (commit e838580)

Two-pronged fix:

1. **Crank now settles warmup for visited accounts**: `keeper_crank()` calls `touch_account()` + `settle_warmup_to_capital_for_crank()` for each visited account. Over time, the zombie's positive PnL converts to capital (at the haircut ratio), making it eligible for maintenance fee draining and eventual GC.

2. **Fee debt subtracted from equity**: `account_equity_mtm_at_oracle()`, `execute_trade()` margin checks, and `withdraw()` now subtract fee debt (negative `fee_credits`) from equity. This makes zombies with `capital=0, fee_credits=-huge, pnl=+huge` appear undercollateralized, enabling liquidation.

### Verification

Deployed updated program to devnet. Comprehensive tests (12/12) pass. TEST 1 (Full Lifecycle) now shows `pnl=0.000000` immediately after close, confirming the crank is proactively settling warmup.

---

## Finding F: Oracle Authority Has No Price Bounds (HIGH → PARTIALLY MITIGATED)

**Status: PARTIALLY FIXED by oracle price circuit breaker (commit 33bed47)**

### Summary

The `PushOraclePrice` instruction previously accepted any positive u64 price with no bounds. The circuit breaker (`oracle_price_cap_e2bps`) now clamps price changes per update. Current devnet configuration: max 10% change per update.

### Remaining Concerns

1. **No upper bound on `max_change_e2bps`**: Admin can set cap to 10,000,000 (1000%), effectively disabling it
2. **Cap is per-update, not per-time-period**: Rapid successive pushes can move price arbitrarily far (each capped at 10% from the previous)
3. **`last_effective_price_e6` starts at 0**: First price push after initialization is unclamped (0 → any value)

### Recommendation

1. Add maximum bound on `max_change_e2bps` (e.g., <= 500,000 = 50%)
2. Add rate limiting (max N price updates per M slots)
3. Initialize `last_effective_price_e6` to a reasonable value at market creation

---

## Finding J: Fee Evasion via Matcher-Controlled Execution Price (HIGH)

**Status: OPEN**

### Summary

Trading fees are computed on `exec_price * |exec_size|` (line 2710-2712), but `exec_price` is returned by the matcher CPI with no validation that it's close to oracle_price. A colluding LP can set `exec_price = 1` to pay near-zero fees.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `execute_trade()` lines 2668-2712

Fee calculation: `notional = |exec_size| * exec_price / 1_000_000`, `fee = notional * trading_fee_bps / 10_000`

Only validation on exec_price: `!= 0 && <= MAX_ORACLE_PRICE`. No proximity check to oracle_price.

### Recommendation

1. Compute trading fees on `oracle_price` instead of `exec_price`
2. Or add minimum fee per trade
3. Or validate `exec_price` proximity to `oracle_price`

---

## Finding N: Warmup Slope Floor Enables Accelerated Micro-PnL Extraction (MEDIUM)

**Status: OPEN — code-verified**

### Summary

The warmup slope has a floor of 1 (via `max(1, avail_gross / warmup_period_slots)`). For tiny PnL amounts (e.g., PnL = 1 lamport), slope = 1, so the full PnL warms up in 1 slot instead of `warmup_period_slots`. By making many micro-trades that each generate 1 unit of PnL, a user can extract profits much faster than the warmup period intends.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `update_warmup_slope()` ~line 2043

```
slope = max(1, avail_gross / warmup_period_slots)
```

With `warmup_period_slots = 1000` and `PnL = 1`: slope = max(1, 1/1000) = 1. After 1 slot: `cap = 1 * 1 = 1 ≥ PnL`. Full warmup in 1 slot instead of 1000.

### Mitigating Factors

- Each micro-trade costs a transaction fee (~5000 lamports on Solana)
- Trading fees further bound the attack
- The extracted PnL per micro-trade is tiny (1 lamport)
- Net profitability depends on fee structure vs PnL extraction rate

### Recommendation

Set slope floor to 0 instead of 1. If slope = 0, no warmup conversion occurs (PnL effectively queued). Or use a higher precision (e.g., slope in fixed-point) to avoid the floor issue.

---

## Finding O: `close_account` Skips Crank Freshness Check (MEDIUM)

**Status: OPEN — code-verified**

### Summary

`close_account()` does not call `require_fresh_crank()` or `require_recent_full_sweep()`, unlike `withdraw()` which gates on both. This allows account closure with stale system state.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `close_account()` ~line 1258

Compare:
- `withdraw()` at line 2390-2393: calls `require_fresh_crank(now_slot)` and `require_recent_full_sweep(now_slot)`
- `close_account()`: only calls `touch_account_full(idx, now_slot, oracle_price)`, no crank/sweep checks

### Impact

During periods of stale cranks (e.g., system stress), users can close accounts and extract capital before liquidations have been processed and the haircut ratio has been properly updated.

### Recommendation

Add `require_fresh_crank()` and `require_recent_full_sweep()` checks to `close_account()` before allowing capital extraction.

---

## Finding D: Partial Liquidation Can Cascade Into Full Close (MEDIUM)

**Status: OPEN**

### Summary

After partial liquidation, the safety check re-evaluates margin using reduced capital (from mark PnL settlement). This can trigger immediate full liquidation.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, ~line 1980-1993

### Recommendation

`compute_liquidation_close_amount` should account for the capital drain that occurs during partial close settlement.

---

## Finding B: Warmup Settlement Ordering Unfairness (MEDIUM)

**Status: OPEN (low impact when haircut = 1)**

### Summary

The haircut ratio is a global value that changes as each account settles warmup. Accounts that settle first get a different (potentially better) rate. Settlement order is deterministic by account index.

### Recommendation

Snapshot the haircut ratio at crank sweep start and use it for all settlements in that sweep.

---

## Finding I: Admin Config Updates Have No Cross-Parameter Validation (MEDIUM)

**Status: OPEN**

### Summary

`UpdateConfig`, `SetMaintenanceFee`, and `SetRiskThreshold` accept parameter values with minimal validation. Admin can set `initial_margin_bps < maintenance_margin_bps`, `warmup_period_slots = 0`, extreme maintenance fees, etc.

### Recommendation

Add cross-parameter validation enforcing invariants (initial > maintenance margin, warmup > 0, etc.).

---

## LP Position Blocks Auto-Recovery (LOW)

**Status: OPEN (workaround exists)**

### Summary

When LP has a profitable position during crisis, all traders are liquidated but LP's counterparty position persists, keeping `totalOI > 0` and blocking auto-recovery.

### Workaround

Admin calls `topUpInsurance` with enough to cover lossAccum + threshold.

---

## Build Configuration: `unsafe_close` Feature Flag (INFO)

**Status: OPEN — requires build discipline**

### Summary

The `CloseSlab` instruction has a `#[cfg(feature = "unsafe_close")]` path that bypasses admin checks. If enabled in production, any signer could close any slab.

### Recommendation

Never enable in production builds. Add CI check to verify feature is not enabled.
