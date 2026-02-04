# Percolator Security Audit — Open Issues

## Finding L: Trade Margin Check Uses `maintenance_margin_bps` Instead of `initial_margin_bps` (HIGH)

**Status: FIXED in core engine commit 9731300, verified on devnet**

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

### Fix (commit 9731300)

`execute_trade()` now checks whether the trade is risk-increasing (`|new_pos| > |old_pos|`):
- Risk-increasing: requires `initial_margin_bps` (10%)
- Risk-reducing: requires `maintenance_margin_bps` (5%)

```rust
let user_risk_increasing = new_user_pos_abs > old_user_pos_abs;
let margin_bps = if user_risk_increasing {
    self.params.initial_margin_bps
} else {
    self.params.maintenance_margin_bps
};
```

### Verification

15x leverage trade now correctly REJECTED (was previously ACCEPTED):
```
  Size: 77938272887
  At 10% initial margin: need 0.075000 SOL equity
  Actual equity:              0.050000 SOL
  Result: REJECTED (correct)
```

---

## Finding M: Funding Rate Retroactive Application Creates Manipulation Window (HIGH → LOW)

**Status: MITIGATED via anti-retroactivity pattern in core engine**

### Summary

The original concern was that a newly computed funding rate would be applied retroactively for the entire elapsed period. **This attack does not work** because the core engine implements anti-retroactivity correctly.

### Anti-Retroactivity Implementation

**File:** `/home/anatoly/percolator/src/percolator.rs`, `keeper_crank()` lines 1507-1514

```rust
// Accrue funding first using the STORED rate (anti-retroactivity).
// This ensures funding charged for the elapsed interval uses the rate that was
// in effect at the start of the interval, NOT the new rate computed from current state.
self.accrue_funding(now_slot, oracle_price)?;

// Now set the new rate for the NEXT interval (anti-retroactivity).
// The funding_rate_bps_per_slot parameter becomes the rate for [now_slot, next_accrual).
self.set_funding_rate_for_next_interval(funding_rate_bps_per_slot);
```

### Why the Attack Fails

1. Slot 100: LP balanced, crank called → stored rate set based on balanced LP (e.g., 0)
2. Slot 100-299: No crank called
3. Slot 299: Attacker opens large SHORT → LP forced net LONG
4. Slot 300: Attacker calls crank:
   - `accrue_funding()` uses the **stored rate from slot 100** (0), not the skewed rate
   - Funding for slots 100-300 is computed at rate 0 → no manipulation
   - Only AFTER accruing, the new skewed rate is stored for slots 300+

### Remaining Concern (LOW)

The rate set at any crank applies to the entire next interval. If LP inventory changes significantly within an interval (between cranks), the rate isn't TWAP for that period. However:
- Regular keepers crank frequently (every few slots)
- `max_crank_staleness_slots` limits how stale cranks can be before trades/withdrawals are blocked
- Impact is proportional to stale interval length, which is naturally bounded

### Devnet Verification

```
Funding applied over ~5 slots
Victim (LONG) funding delta: 0.000000
LP funding delta: -0.000490
No funding accrued (balanced or rate = 0)
```

The zero funding delta confirms the stored rate (0) was used, not the newly computed rate.

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

**Status: FIXED in core engine commit 9cdc92b (ceiling division), devnet verification pending**

### Summary

Trading fees are computed on `exec_price * |exec_size|` (line 2710-2712), but `exec_price` is returned by the matcher CPI with no validation that it's close to oracle_price. A colluding LP can set `exec_price = 1` to pay near-zero fees.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `execute_trade()` lines 2668-2712

Fee calculation: `notional = |exec_size| * exec_price / 1_000_000`, `fee = notional * trading_fee_bps / 10_000`

Only validation on exec_price: `!= 0 && <= MAX_ORACLE_PRICE`. No proximity check to oracle_price.

### Related: Zero-Fee via Small Size (devnet verified)

Even without exec_price manipulation, fee rounding enables zero-fee trades:

```
trading_fee_bps: 10 (0.10%)
Zero-fee threshold: size < 103,917 at price 9623

Test: 10 micro round-trips
  Total insurance delta: 0.000000
  All trades executed with zero fees
```

The NoOpMatcher returns `exec_price = oracle_price`, so exec_price manipulation wasn't tested. However, if a malicious matcher returned `exec_price = 1`, all trades would pay near-zero fees regardless of size.

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

## Finding O: `close_account` Skips Crank Freshness Check (MEDIUM → LOW)

**Status: OPEN — severity reduced upon review**

### Summary

`close_account()` does not call `require_fresh_crank()` or `require_recent_full_sweep()`, unlike `withdraw()` which gates on both. This allows account closure with stale system state.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `close_account()` ~line 1272

Compare:
- `withdraw()` at line 2442-2445: calls `require_fresh_crank(now_slot)` and `require_recent_full_sweep(now_slot)`
- `close_account()`: only calls `touch_account_full(idx, now_slot, oracle_price)`, no crank/sweep checks

### Impact Analysis (Reduced Severity)

The original concern was that users could extract capital during stale periods before liquidations are processed. However:

1. `close_account` requires `position_size == 0` (line 1285-1286)
2. `close_account` requires `pnl == 0` (lines 1302-1306)
3. `touch_account_full` settles all funding/fees/warmup before the checks

For an account with zero position and zero PnL, the "extraction" is just returning capital that's already marked as the user's. There's no PnL that could be affected by haircut calculations, and no position that could be affected by liquidation.

The remaining risk is minimal: during extreme stress, a user could close faster than they could withdraw, but both operations return the same capital.

### Recommendation

For consistency, consider adding freshness checks. But given the existing safeguards (zero position, zero PnL required), the practical risk is LOW.

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

---

## Hyperp Mode Security Analysis (2026-02-03)

### Finding P: TradeCpi Allows Arbitrary Mark Price via Malicious Matcher (HIGH)

**Status: OPEN**

### Summary

In Hyperp mode, `TradeCpi` sets the mark price to `exec_price_e6` returned by the external matcher program with no bounds validation. A malicious matcher can return an extreme exec_price, allowing mark price manipulation.

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, lines 3104-3107

```rust
if is_hyperp {
    let mut config = state::read_config(&data);
    config.authority_price_e6 = ret.exec_price_e6;  // FROM MATCHER - NO BOUNDS CHECK
    state::write_config(&mut data, &config);
}
```

The ABI validation only checks `exec_price_e6 != 0` but does NOT constrain it relative to the current oracle/index price.

### Impact

- Mark price can be set to any u64 value by a complicit LP/matcher
- Funding rate calculations use the manipulated mark
- If `oracle_price_cap_e2bps = 0` (default), index also jumps to mark
- Attackers can drain funds via distorted funding payments

### Mitigating Factor

The LP loses money on the trade itself (PnL uses `oracle_price - exec_price`), providing economic disincentive. However, a coordinated attacker controlling both LP and user accounts could still exploit this.

### Recommendation

Add bounds check on exec_price relative to current index price:
```rust
if is_hyperp {
    let max_deviation = oracle_price * MAX_DEVIATION_BPS / 10000;
    if exec_price > oracle_price + max_deviation || exec_price < oracle_price.saturating_sub(max_deviation) {
        return Err(PercolatorError::PriceDeviationTooLarge);
    }
}
```

---

### Finding Q: Index Can Jump Instantly When oracle_price_cap_e2bps = 0 (MEDIUM)

**Status: OPEN**

### Summary

At market initialization, `oracle_price_cap_e2bps` defaults to 0, which disables rate limiting for index smoothing. This allows the index to instantly jump to any mark price.

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, line 2381 and lines 1935-1936

```rust
// InitMarket:
oracle_price_cap_e2bps: 0,  // disabled by default

// clamp_toward_with_dt:
if cap_e2bps == 0 || dt_slots == 0 { return mark; }  // Bypasses rate limiting!
```

### Impact

- Index can jump to any mark value in a single crank
- Combined with Finding P, allows instant propagation of manipulated prices
- Defeats the purpose of gradual index smoothing for funding stability

### Recommendation

1. Set a non-zero default for `oracle_price_cap_e2bps` in Hyperp markets
2. Or require admin to explicitly enable Hyperp mode with a reasonable cap

---

### Finding R: TradeNoCpi Sets Mark = Index (Logic Bug) (LOW)

**Status: OPEN**

### Summary

In Hyperp mode, `TradeNoCpi` sets the mark price to the current index price, not the trade execution price. This collapses mark-index premium to zero.

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, lines 2890-2894

```rust
if is_hyperp {
    let mut config = state::read_config(&data);
    config.authority_price_e6 = price;  // `price` is the INDEX, not exec_price!
    state::write_config(&mut data, &config);
}
```

The `price` variable was set from `config.last_effective_price_e6` (the index) at line 2828.

### Impact

- Mark always equals index after TradeNoCpi trades
- Premium is always zero, eliminating the funding mechanism's purpose
- This may not be the intended behavior

### Recommendation

Review whether TradeNoCpi should update mark to the trade's entry price (similar to TradeCpi) or leave mark unchanged.

---

### Finding S: No Bounds on funding_k_bps in UpdateConfig (LOW)

**Status: OPEN**

### Summary

The `UpdateConfig` instruction does not bound `funding_k_bps`, allowing admin to set extreme funding rate multipliers.

### Impact

An admin could set `funding_k_bps = 1_000_000` (10000x), causing punitive funding rates. Mitigated by `max_bps_per_slot` cap, but still allows admin misconfiguration.

### Recommendation

Add bounds validation: `funding_k_bps <= MAX_FUNDING_K_BPS` (e.g., 1000 = 10x)
