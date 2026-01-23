# LP Position Desync Finding

## Summary

During red team security testing, a position accounting discrepancy was discovered between the LP's position and the sum of user positions.

**Observed:**
- LP position: `-3,394,330,890,648` units
- Sum of user positions: `3,394,330,790,648` units
- **Mismatch: `100,000` units** (LP is 100k more short than expected)

The mismatch value exactly equals `min_liquidation_abs` (100,000), suggesting this is caused by dust position cleanup.

---

## Technical Details

### The Invariant

In a properly balanced perpetual market, the LP should always be the exact counterparty to all user positions:

```
LP_position = -SUM(user_positions)
```

This ensures that for every long, there's a corresponding short, and vice versa.

### Observed State

From `state.json` at the time of discovery:

```
Engine State:
  net_lp_pos:           -3,394,330,890,648
  lp_sum_abs:            3,394,330,890,648
  total_open_interest:   6,788,661,681,296
  lifetime_force_closes: 2
  lifetime_liquidations: 0

LP Account:
  position_size:        -3,394,330,890,648

User Accounts:
  Account 8:   730,284,329,350 (LONG)
  Account 9:   271,201,194,805 (LONG)
  Account 10: 2,392,845,266,493 (LONG)
  ─────────────────────────────────
  User Sum:  3,394,330,790,648

Mismatch:
  Expected LP: -3,394,330,790,648
  Actual LP:   -3,394,330,890,648
  Difference:            -100,000 units
```

### Open Interest Consistency

Notably, the total open interest IS consistent:

```
OI = |LP| + |User8| + |User9| + |User10|
   = 3,394,330,890,648 + 730,284,329,350 + 271,201,194,805 + 2,392,845,266,493
   = 6,788,661,681,296 ✓ (matches reported totalOpenInterestUnits)
```

This means the OI tracking is correct, but the LP vs user balance is not.

---

## Root Cause Analysis

### Hypothesis: Dust Position Force-Close

The mismatch of exactly `100,000` units (= `min_liquidation_abs`) strongly suggests this is caused by the dust position cleanup mechanism.

#### How Dust Cleanup Works

From `percolator.rs` lines 3454-3481:

```rust
// BUG FIX: Force-close accounts with negative equity OR dust positions.
if !self.accounts[idx].position_size.is_zero() {
    let equity = self.account_equity_mtm_at_oracle(&self.accounts[idx], oracle_price);
    let abs_pos = self.accounts[idx].position_size.unsigned_abs();
    let is_dust = abs_pos < self.params.min_liquidation_abs.get();

    if equity == 0 || is_dust {
        // Equity is zero/negative OR position is dust - force close immediately
        match self.force_close_position_deferred(idx, oracle_price) {
            Ok((_mark_pnl, deferred)) => {
                self.lifetime_force_realize_closes =
                    self.lifetime_force_realize_closes.saturating_add(1);
                // Accumulate unpaid loss for socialization
                self.pending_unpaid_loss = self
                    .pending_unpaid_loss
                    .saturating_add(deferred.unpaid_loss);
            }
            // ...
        }
    }
}
```

#### What `force_close_position_deferred` Does

From lines 3063-3140:

```rust
fn force_close_position_deferred(&mut self, idx: usize, oracle_price: u64) -> Result<(i128, DeferredAdl)> {
    // ...

    // Compute mark PnL at oracle price
    let mark_pnl = Self::mark_pnl_for_position(pos, entry, oracle_price)?;

    // Apply mark PnL to account
    self.accounts[idx].pnl = self.accounts[idx].pnl.saturating_add(mark_pnl);

    // Close position
    self.accounts[idx].position_size = I128::ZERO;  // <-- User position zeroed

    // Update OI
    self.total_open_interest = self.total_open_interest - abs_pos;  // <-- OI reduced

    // Update LP aggregates if this is an LP account (O(1))
    if self.accounts[idx].is_lp() {
        self.net_lp_pos = self.net_lp_pos - pos;  // <-- Only adjusted if LP
        self.lp_sum_abs = self.lp_sum_abs - abs_pos;
    }

    // NOTE: LP position is NOT adjusted when closing a USER position
    // ...
}
```

#### The Sequence That Creates Orphaned LP Position

1. **User opens small position:**
   - User goes LONG 50,000 units
   - LP takes other side: LP position -= 50,000 (goes more SHORT)

2. **Position becomes dust:**
   - Position is below `min_liquidation_abs` threshold (100,000)
   - Crank identifies this as dust

3. **Crank force-closes dust:**
   - `force_close_position_deferred(user_idx, oracle_price)` is called
   - User's `position_size` is set to 0
   - `total_open_interest` is reduced by 50,000
   - User's mark PnL is calculated and applied
   - **LP's position is NOT adjusted** (LP was the counterparty, not the one being closed)

4. **Result:**
   - User position: 0
   - LP position: still has the -50,000 from the original trade
   - **LP has "orphaned" short exposure with no user counterpart**

5. **Repeat for another dust position:**
   - Total orphaned LP exposure: 100,000 units
   - This matches `lifetime_force_closes = 2`

---

## Impact Analysis

### Immediate Impact

| Metric | Value |
|--------|-------|
| Orphaned LP position | 100,000 units |
| Notional value | ~0.00077 SOL |
| As % of vault | ~0.01% |

The immediate financial impact is negligible.

### Conservation Equation

The conservation invariant still holds:

```
vault (6.22 SOL) >= capital (4.25 SOL) + insurance (1.21 SOL)
6.22 >= 5.46 ✓
```

The extra ~0.76 SOL in the vault is unrealized PnL, which is expected.

### Long-Term Risk

The orphaned LP position will continue to generate PnL based on oracle price movements:

- **If price goes UP:** LP's orphaned short loses money, but no user gains the corresponding amount
- **If price goes DOWN:** LP's orphaned short profits, but no user loses the corresponding amount

This creates a **PnL leak** where:
- LP may accumulate losses not offset by any user gains
- Or LP may accumulate gains not offset by any user losses

Over many dust force-closes, this could accumulate to a significant amount.

---

## Is This a Bug or By Design?

### Arguments for "By Design"

1. **LP absorbs imbalances:** The LP is designed to be the market maker and absorb risk. Orphaned positions from dust cleanup could be considered part of LP's role.

2. **PnL was already settled:** When the dust position is force-closed, its mark PnL is calculated and settled (either socialized or paid from insurance). The LP's offsetting position's PnL at that moment was also implicitly settled.

3. **Dust is tiny:** Positions below `min_liquidation_abs` (100,000 units ≈ 0.00077 SOL notional) are economically insignificant individually.

### Arguments for "Bug"

1. **Invariant violation:** The fundamental invariant `LP = -users` is violated. This could cause issues in edge cases or accumulate over time.

2. **Unbounded accumulation:** Each dust force-close adds to the orphaned position. With enough force-closes, this could become significant.

3. **Asymmetric risk:** The LP bears risk that no user is exposed to. This could affect LP capital requirements or insurance fund calculations.

---

## Potential Fixes

### Option 1: Adjust LP on Dust Close

When force-closing a user's dust position, also adjust the LP's position:

```rust
// In force_close_position_deferred for USER accounts:
if !self.accounts[idx].is_lp() {
    // Find the LP that was counterparty and adjust their position
    // This requires knowing which LP took the other side
    self.net_lp_pos = self.net_lp_pos + pos;  // Reduce LP's offsetting position
}
```

**Complexity:** Need to track which LP was counterparty, or distribute adjustment across all LPs.

### Option 2: Prevent Dust Positions

Enforce minimum position sizes on trade entry:

```rust
// In execute_trade:
if saturating_abs_i128(new_user_position) < self.params.min_liquidation_abs.get()
   && new_user_position != 0 {
    return Err(RiskError::PositionTooSmall);
}
```

**Downside:** Users can't close to small positions; must close entirely.

### Option 3: Accept as LP Risk

Document that orphaned positions from dust cleanup are part of LP's risk. LP should price this into their capital requirements.

**Downside:** Doesn't fix the accounting discrepancy.

---

## Recommendations

1. **Review with team:** Determine if this is intentional design or a bug that needs fixing.

2. **Monitor accumulation:** Add metrics to track total orphaned LP position over time.

3. **Consider minimum position sizes:** Preventing dust positions at entry would eliminate this edge case.

4. **Document LP risk:** If by design, clearly document that LP bears orphaned position risk from dust cleanup.

---

## Test Reproduction

To reproduce this finding:

```bash
# Run the investigation script
npx tsx scripts/investigate-lp-desync.ts

# Or run the full red team test suite
npx tsx scripts/audit-redteam.ts
```

The `investigate-lp-desync.ts` script will show the current LP vs user mismatch.

---

## References

- `percolator.rs` lines 3454-3481: Dust position detection in crank
- `percolator.rs` lines 3063-3140: `force_close_position_deferred` implementation
- `scripts/audit-redteam.ts`: Red team attack test that discovered this
- `scripts/investigate-lp-desync.ts`: Detailed investigation script
