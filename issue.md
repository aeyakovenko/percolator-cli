# Percolator Security Audit — Open Issues

## Finding F: Oracle Authority Has No Price Bounds or Deviation Checks (HIGH)

**Status: OPEN**

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

Only validation: `price_e6 != 0`. Missing: upper bound, deviation check, timestamp validation, rate limiting, confidence filter. The authority price also has no MAX_ORACLE_PRICE bound check (unlike engine-level validation at crank/trade time).

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

## LP Position Blocks Auto-Recovery (LOW)

**Status: OPEN (workaround exists)**

### Summary

When the LP has a profitable position (e.g., SHORT during a crash), all traders are liquidated but the LP's counterparty position persists. This keeps `totalOI > 0`, blocking auto-recovery. The system stays in force-realize mode indefinitely.

### Workaround

Admin calls `topUpInsurance` with enough to cover lossAccum + threshold.

---

## Build Configuration: `unsafe_close` Feature Flag (INFO)

**Status: OPEN — requires build discipline**

### Summary

The `CloseSlab` instruction in `/home/anatoly/percolator-prog/src/percolator.rs` has a `#[cfg(feature = "unsafe_close")]` path that bypasses admin checks, state validation, and data zeroing. It exists for development (CU limit workaround).

### Risk

If enabled in a production build, any signer could close any slab and drain its lamports without authorization.

### Recommendation

Ensure `unsafe_close` feature is never enabled in production builds. Consider adding a compile-time assertion or CI check.
