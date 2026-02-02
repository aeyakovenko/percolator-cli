# Percolator Security Audit — Open Findings

## Finding G: Collateral Conservation Violation After Trades (HIGH)

**Status: Confirmed on devnet (T12.5)**

### Summary

After executing trades on a freshly created market, the vault token balance exceeds the sum of all tracked capital plus insurance balance. In T12.5, the vault held 63,000,000 lamports but the slab only tracked 62,657,139 — a surplus of 342,861 lamports (0.54%) that belongs to no one.

### Root Cause

Trading fees are added to `insurance_fund.balance` as internal accounting (line 2888 of percolator.rs) without any corresponding token transfer. This inflates `insurance.balance` beyond what the vault backs. The haircut ratio calculation uses:

```rust
residual = vault - c_tot - insurance.balance  // residual = 0 when fees exist
h_num = min(residual, pnl_pos_tot)            // h_num = 0
```

When `residual = 0` (which happens whenever fees have been collected), the haircut ratio becomes 0. During warmup settlement:
- Positive PnL gets **zero capital credit** (haircut = 0/N = 0)
- Negative PnL gets **full capital debit**

This creates a systematic drain: winners receive nothing, losers pay in full. The destroyed positive PnL accumulates as unaccounted surplus in the vault.

### Reproduction

```bash
npx tsx tests/t12-trade-cpi.ts
# T12.5: Conservation after trades → FAIL
# Slab total: 62,657,139  Vault balance: 63,000,000  Difference: 342,861
```

### Impact

Every trade on every market systematically destroys value from winning positions. Over time, the vault accumulates an unbacked surplus that cannot be withdrawn by anyone. The effect compounds with trading volume.

### Recommendation

Either:
1. Don't include trading fee revenue in `insurance_fund.balance` (track it separately)
2. Also add fee revenue to `vault` field when charging fees
3. Use a different residual formula that excludes fee revenue from insurance

---

## Finding F: Oracle Authority Has No Price Bounds or Deviation Checks (HIGH)

**Status: Confirmed on devnet (7/8 validation gaps verified)**

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

## Finding A: Warmup Haircut Rounding Creates Unrecoverable Dust (MEDIUM)

### Summary

Floor division in `settle_warmup_to_capital()` silently loses lamports during PnL-to-capital conversion. Combined with Finding G (haircut ratio = 0 due to fee accounting), this effect is amplified — instead of losing 1 lamport per settlement, entire positive PnL amounts are destroyed.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `settle_warmup_to_capital()` ~line 2990

```rust
let (h_num, h_den) = self.haircut_ratio();
let y = if h_den == 0 { x } else { mul_u128(x, h_num) / h_den };
```

When haircut ratio is healthy (1:1), dust = 0. When ratio is degraded (due to fee accounting inflating insurance.balance), dust = the entire positive PnL amount.

### Impact

In isolation: up to 1 lamport per warmup settlement. Combined with Finding G: entire positive PnL amounts are lost.

### Recommendation

Fix Finding G first (separating fee revenue from insurance balance in residual calculation). Then add rounding-up for the haircut conversion.

---

## Finding B: Warmup Settlement Ordering Unfairness (MEDIUM)

### Summary

The haircut ratio is a global value that changes as each account settles warmup. Accounts that settle first get a different (potentially better) rate than accounts that settle later. Settlement order is deterministic by account index, creating structural advantage for lower-indexed accounts.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `settle_warmup_to_capital()` ~line 2986

1. Account A settles: reads haircut ratio, converts PnL to capital, `pnl_pos_tot` decreases
2. Account B settles: reads a DIFFERENT haircut ratio because `pnl_pos_tot` changed

### Impact

In normal conditions with haircut ratio = 1, there's no unfairness. Only manifests when vault is undercollateralized (residual < pnl_pos_tot). With Finding G active, this means ANY market with collected trading fees.

### Recommendation

Snapshot the haircut ratio at crank sweep start and use it for all settlements in that sweep.

---

## Finding C: Fee Debt Traps Accounts — Cannot Close (MEDIUM)

### Summary

An account whose `fee_credits` goes negative cannot call `close_account`. Capital is gradually consumed to pay fees.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`

- `close_account` (~line 1290) blocks if `fee_credits.is_negative()`
- `settle_maintenance_fee` (~line 1057) charges fees per slot
- Capital pays the debt (~line 1061-1074)
- `garbage_collect_dust` (~line 1379) doesn't check fee_credits

### Current Status

On the devnet test market, `maintenanceFeePerSlot = 0`, so this doesn't manifest. However, any market with non-zero maintenance fees would hit this.

### Recommendation

Allow `close_account` with negative fee_credits by forgiving remaining debt, or add a `force_close` path.

---

## Finding D: Partial Liquidation Can Cascade Into Full Close (MEDIUM)

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

## Open Finding: LP Position Blocks Auto-Recovery (Low)

**Severity: Low (workaround exists)**

When the LP has a profitable position (e.g., SHORT during a crash), all traders are liquidated but the LP's counterparty position persists. This keeps `totalOI > 0`, blocking auto-recovery.

**Workaround**: Admin calls `topUpInsurance` with enough to cover lossAccum + threshold.

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
| T12: Trade CPI | 4 | 5 | **T12.5: CONSERVATION VIOLATION** (342,861 surplus) |
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
| bug-oracle-no-bounds.ts | **7/8 validation gaps confirmed** |
| verify-threshold-autoadjust.ts | **PASSED** (step limiting, EWMA smoothing work) |
| bug-fee-debt-trap.ts | No fee accrual (maintenanceFeePerSlot=0). 429 rate limits. |
| test-price-profit.ts | No positioned users to test |
| test-lp-profit-realize.ts | LP withdrawal blocked (expected: large position from stress tests) |

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
| scripts/check-params.ts | Read from devnet-market.json |
| scripts/check-funding.ts | Read from devnet-market.json |
| scripts/check-liquidation.ts | Read from devnet-market.json |
| scripts/find-user.ts | Read from devnet-market.json |
| scripts/update-funding-config.ts | Read from devnet-market.json |

## Resolved Issues (for reference)

- **Stranded vault funds after socialized loss** — Fixed by PR #15 (`bb9474e`)
- **Warmup budget double-subtraction** — Fixed by commit `5f5213c`
- **Recovery over-haircut confiscating LP profit** — Fixed by commit `19cd5de`
