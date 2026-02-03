# Percolator Security Audit — Open Issues

## Finding K: Zero-Capital "PnL Zombie" Accounts Poison Global Haircut Ratio (CRITICAL)

**Status: OPEN — actively impacting devnet market**

### Summary

An account with 0 capital but positive PnL and a small position becomes a "PnL zombie" that cannot be closed, garbage-collected, or liquidated. Its unbounded positive PnL dominates `pnl_pos_tot`, collapsing the global haircut ratio to near-zero. **All profitable traders on the market lose 99.99% of their earned PnL during warmup conversion.**

### Devnet Evidence

```
Account [9]: position=2160141, capital=0 SOL, pnl=998,339.85 SOL

Engine state:
  vault:       170.43 SOL
  c_tot:        12.30 SOL
  pnl_pos_tot: 998,339.91 SOL  ← dominated by account 9
  insurance:    35.71 SOL

  Residual:    122.42 SOL
  Haircut:     122.42 / 998,339.91 = 0.012%
```

Result: a legitimate trader earning 0.129 SOL profit from a +5% price move receives only 0.000016 SOL after warmup conversion (99.99% loss to haircut).

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`

1. **Mark settlement inflates PnL without bound** (~line 2206): `settle_mark_to_oracle()` adds mark PnL to `account.pnl` and calls `set_pnl()` which updates `pnl_pos_tot`. For a zero-capital account with a position, every favorable price move increases its PnL unboundedly.

2. **No positive PnL write-off** (~line 1910-1911): The engine writes off negative PnL (`if pnl.is_negative() { set_pnl(idx, 0) }`), but positive PnL on a zero-capital account is never written off.

3. **GC blocked by positive PnL** (~line 1393): `garbage_collect_dust()` requires `pnl <= 0` to free an account. Positive PnL prevents GC.

4. **Close blocked by positive PnL** (~line 1300-1301): `close_account()` returns `PnlNotWarmedUp` for positive PnL.

5. **Liquidation blocked by effective equity** (~line 1954): `effective_pos_pnl(pnl)` = `pnl * haircut` = 998,339 × 0.012% = 122 SOL. This exceeds maintenance margin (≈1 SOL), so the account is not liquidatable.

6. **Warmup never triggers**: `settle_warmup_to_capital()` is NOT called during `keeper_crank()`. It only fires on user operations (deposit/withdraw/close). Since nobody interacts with account 9, its PnL never converts.

### How This State Arises (normal market operation)

1. User opens a position with capital
2. Price moves favorably → PnL becomes positive
3. Maintenance fees drain capital to 0 over time (no active management)
4. Crank continues settling mark_to_oracle → PnL grows unboundedly
5. Account becomes a PnL zombie: can't close (PnL > 0), can't GC (PnL > 0), can't liquidate (effective equity > margin)
6. `pnl_pos_tot` grows with every crank, haircut ratio drops for ALL traders

### Impact

- **CRITICAL**: All profitable traders lose nearly 100% of their earned PnL
- The market is functionally broken for profit realization
- The problem is self-reinforcing: as PnL grows, haircut drops further
- Can occur in normal market operation (no attacker required)
- No admin instruction exists to fix the state

### Recommendation

1. **Write off positive PnL on zero-capital accounts**: In `garbage_collect_dust()` or `keeper_crank()`, if `capital == 0 && pnl > 0`, call `set_pnl(idx, 0)` to write off the phantom PnL
2. **Cap pnl_pos_tot contribution**: Don't count PnL from accounts with 0 capital in `pnl_pos_tot`
3. **Settle warmup during crank**: Add `settle_warmup_to_capital()` calls in the keeper crank loop for accounts with positive PnL and 0 capital
4. **Force-close zombie accounts**: Allow the crank to force-close accounts with `position=small, capital=0, pnl>0` by writing off the PnL and freeing the slot

---

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

## Finding J: Fee Evasion via Matcher-Controlled Execution Price (HIGH)

**Status: OPEN**

### Summary

Trading fees are computed on `exec_price * |exec_size|` (line 2710-2712), but `exec_price` is returned by the matcher CPI with no validation that it's close to oracle_price. A colluding LP can set `exec_price = 1` to pay near-zero fees, starving the insurance fund of revenue.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `execute_trade()` lines 2668-2712
**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, CpiMatcher line 1983-2002, return data line 2815-2827

Fee calculation:
```
notional = |exec_size| * exec_price / 1_000_000          // line 2710-2711
fee = notional * trading_fee_bps / 10_000                 // line 2712
```

exec_price validation (line 2673): only checks `exec_price != 0 && exec_price <= MAX_ORACLE_PRICE`. No check that exec_price is within any range of oracle_price.

### Attack Scenario

1. Attacker deploys custom matcher program that returns `exec_price = 1` for all trades
2. Attacker registers as LP with this matcher
3. All trades through this LP compute fees on `notional = |exec_size| * 1 / 1_000_000 ≈ 0`
4. Fee = 0 for practically any trade size
5. Insurance fund receives zero revenue from trading fees

**Example with current market:**
- Oracle price: 9,623 (inverted SOL)
- Trade size: 300,000,000,000
- Normal fee: `(300B × 9623 / 1M) × 10 / 10000 = 2,886,900` (≈0.0029 SOL)
- With exec_price=1: `(300B × 1 / 1M) × 10 / 10000 = 30` (≈0.00000003 SOL)

The trade PnL is still computed from `(oracle_price - exec_price) * exec_size`, so the LP takes a massive loss equal to the user's gain — but if both accounts are controlled by the same entity, the net is zero (wash trade) and fees are evaded.

### Impact

- Insurance fund is starved of trading fee revenue
- Protocol earns nothing from wash trades
- Over time, insurance fund doesn't grow, making it more vulnerable to drawdown events
- Fee rounding to zero also applies to legitimate small trades (micro-trade fee evasion via integer floor division)

### Mitigating Factors

- LP is a trusted role; only authorized LPs can set matchers
- Trade PnL is zero-sum, so no extraction occurs beyond fee savings
- Wash trading ties up capital in warmup periods

### Recommendation

1. Compute trading fees on `oracle_price` instead of `exec_price`: `notional = |exec_size| × oracle_price / 1_000_000`
2. Or add minimum fee: `fee = max(fee_calculated, min_trade_fee)`
3. Or validate exec_price proximity: reject if `|exec_price - oracle_price| > deviation_bps * oracle_price`

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

## Finding I: Admin Config Updates Have No Cross-Parameter Validation (MEDIUM)

**Status: OPEN**

### Summary

`UpdateConfig`, `SetMaintenanceFee`, and `SetRiskThreshold` instructions accept parameter values with minimal validation. An admin (even acting in good faith) can set parameter combinations that break margin model invariants or destabilize the market.

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`, UpdateConfig (~line 3117), SetMaintenanceFee (~line 3169), SetRiskThreshold (~line 3028)

### Dangerous Parameter Combinations

| Parameter | Risk | Impact |
|-----------|------|--------|
| `initial_margin_bps` < `maintenance_margin_bps` | No validation | Accounts open below maintenance margin, immediately liquidatable |
| `warmup_period_slots` = 0 | No validation | Disables warmup protection entirely, enables instant profit extraction |
| `maintenance_fee_per_slot` = extreme value | No validation | Drains all account capital on next crank via fee settlement |
| `risk_reduction_threshold` = u128::MAX | No validation | Triggers force-realize on all positions immediately |
| `liquidation_buffer_bps` = extreme value | No validation | Either prevents liquidation entirely (too high) or removes safety buffer (0) |

### Mitigating Factors

- All config changes require admin signer
- Admin is a trusted role by design
- Parameters are set at market initialization with safe defaults

### Recommendation

1. Add cross-parameter validation in `UpdateConfig`: enforce `initial_margin_bps > maintenance_margin_bps`, `warmup_period_slots > 0`, `liquidation_buffer_bps` within reasonable range
2. Add cap validation in `SetMaintenanceFee`: reject unreasonably large values
3. Consider requiring timelock or multi-sig for parameter changes on active markets

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
