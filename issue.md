# Percolator Security Audit — Open Findings

## Open Finding: LP Position Blocks Auto-Recovery

**Severity: Low (workaround exists)**

When the LP has a profitable position (e.g., SHORT during a crash), all traders are liquidated but the LP's counterparty position persists. This keeps `totalOI > 0`, which blocks PR #15's auto-recovery (requires `totalOI == 0`).

Observed in 80% crash scenario:
- LP SHORT(-10T), 5 traders liquidated
- `lossAccum = 11.77 SOL`, `riskReductionOnly = true`
- `totalOI = 10T` (LP position), auto-recovery blocked

**Workaround**: Admin calls `topUpInsurance` with enough to cover lossAccum + threshold. This exits risk-reduction mode via the `exit_risk_reduction_only_mode_if_safe` path, which does NOT require `totalOI == 0`. Verified working.

**Recommendation**: Consider extending `recover_stranded_to_insurance()` to handle the case where the only remaining OI is from the LP's counterparty position.

---

# Security Audit Findings

## Finding A: Warmup Haircut Rounding Creates Unrecoverable Dust (HIGH)

### Summary

Floor division in `settle_warmup_to_capital()` silently loses lamports during PnL-to-capital conversion. The dust is subtracted from PnL but never credited anywhere, creating a permanent vault surplus that belongs to nobody.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `settle_warmup_to_capital()` ~line 2990

```rust
let (h_num, h_den) = self.haircut_ratio();
let y = if h_den == 0 {
    x
} else {
    mul_u128(x, h_num) / h_den     // ← FLOOR DIVISION
};
self.set_pnl(idx as usize, pnl - (x as i128));   // removes x from PnL
self.set_capital(idx as usize, new_cap);            // adds y to capital
```

- `x` lamports are removed from PnL
- `y = floor(x * h_num / h_den)` lamports are added to capital
- Dust = `x - y` is lost every time warmup settles

### Example

```
x = 1000 lamports, h_num = 999, h_den = 1000
y = floor(1000 * 999 / 1000) = 999
Dust = 1000 - 999 = 1 lamport (lost forever)
```

### Impact

Each warmup settlement can lose up to 1 lamport. Over many accounts and many settlement cycles, dust accumulates as unbacked vault surplus. While individual amounts are tiny, the asymmetry is a conservation violation — PnL is debited more than capital is credited.

The `haircut_ratio()` function (line ~820) computes `h_num = min(residual, pnl_pos_tot)` / `h_den = pnl_pos_tot`. When the vault is slightly undercollateralized (residual < pnl_pos_tot), the ratio `h_num/h_den < 1` and floor division creates dust on every settlement.

### Recommendation

Round `y` up instead of down, or accumulate the remainder in a dust counter that gets swept to insurance periodically.

---

## Finding B: Warmup Settlement Ordering Unfairness (MEDIUM)

### Summary

The haircut ratio is a global value that changes as each account settles warmup. Accounts that settle first get a different (potentially better) haircut rate than accounts that settle later in the same crank cycle. Settlement order is deterministic by account index, creating a structural advantage for lower-indexed accounts.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`, `settle_warmup_to_capital()` ~line 2986

```rust
let (h_num, h_den) = self.haircut_ratio();   // reads global state
let y = mul_u128(x, h_num) / h_den;
self.set_pnl(idx, pnl - (x as i128));         // updates pnl_pos_tot
self.set_capital(idx, new_cap);
```

1. Account A settles: reads haircut ratio, converts PnL to capital, `pnl_pos_tot` decreases
2. Account B settles: reads a DIFFERENT haircut ratio because `pnl_pos_tot` changed
3. The ratio `h_num = min(residual, pnl_pos_tot) / pnl_pos_tot` shifts after each settlement

### Mechanism

- `haircut_ratio()` at line ~820: `residual = vault - c_tot - insurance`, `h_num = min(residual, pnl_pos_tot)`
- When residual < pnl_pos_tot (undercollateralized), the ratio is `residual / pnl_pos_tot`
- As each account converts PnL to capital: capital increases (c_tot up), PnL decreases (pnl_pos_tot down), residual decreases
- The direction of change depends on whether `y < x` (which is true when haircut < 1)

### Exploitation

- Settlement is triggered by user operations (`touch_account_full` at ~line 2280) — not queued
- An attacker who knows the haircut is about to change could time their settlement transaction
- During crank, accounts are processed in linear bitmap order from `crank_cursor` (~line 1543), giving lower-indexed accounts structural priority
- No randomization, rotation, or fairness mechanism exists (comment at ~line 2036: "No warmup rate cap (removed for simplicity)")

### Impact

In normal market conditions with a healthy insurance fund, haircut ratio = 1 and there's no unfairness. The issue only manifests when the vault is undercollateralized (residual < pnl_pos_tot), which occurs during/after insurance depletion events. At that point, the ordering advantage becomes proportional to the gap between residual and pnl_pos_tot.

### Recommendation

Snapshot the haircut ratio at the start of each crank sweep and use the snapshot for all settlements in that sweep. This ensures all accounts in the same sweep get the same rate.

---

## Finding C: Fee Debt Traps Accounts — Cannot Close (MEDIUM)

### Summary

An account whose `fee_credits` goes negative cannot call `close_account` to withdraw remaining capital. Maintenance fees continue accruing while the account is idle. Capital is drained to pay fees until eventually the account has zero capital but may still have residual negative fee_credits. The `garbage_collect_dust` function can then free the slot (it doesn't check fee_credits), but the user's capital was consumed by fees with no ability to stop the drain.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`

1. `close_account` (~line 1290) blocks if `fee_credits.is_negative()`:
   ```rust
   if account.fee_credits.is_negative() {
       return Err(RiskError::InsufficientBalance);
   }
   ```

2. `settle_maintenance_fee` (~line 1057) charges fees per slot:
   ```rust
   let due = self.params.maintenance_fee_per_slot.get().saturating_mul(dt as u128);
   account.fee_credits = account.fee_credits.saturating_sub(due as i128);
   ```

3. If fee_credits goes negative, capital pays the debt (~line 1061-1074):
   ```rust
   if account.fee_credits.is_negative() {
       let owed = neg_i128_to_u128(account.fee_credits.get());
       let pay = core::cmp::min(owed, account.capital.get());
       account.capital = account.capital.saturating_sub(pay);
       // ... transfer to insurance ...
       account.fee_credits = account.fee_credits.saturating_add(pay as i128);
   }
   ```

4. `garbage_collect_dust` (~line 1379-1394) dust predicate does NOT check fee_credits:
   ```rust
   // Only checks: position_size == 0, capital == 0, reserved_pnl == 0, pnl <= 0
   // Missing: fee_credits check
   ```

### Attack/Trap Scenario

1. User opens account with small capital (e.g., 0.01 SOL)
2. Closes position, sits idle with zero position
3. Fee_credits drains to negative as maintenance_fee_per_slot accrues over time
4. `close_account` is blocked — user cannot withdraw remaining capital
5. Capital is gradually consumed to pay fees via `pay_fee_debt_from_capital`
6. Eventually capital hits 0 and GC frees the slot — user lost their remaining capital to fees they couldn't escape

### Impact

For accounts with small balances, the fee drain can consume 100% of capital without the user being able to close and withdraw. The trap is self-reinforcing: the longer the user waits, the more fees accrue, the more capital is consumed.

In practice this primarily affects dust accounts and users who abandon small-balance accounts. Larger accounts can deposit fee_credits to stay positive. However, there is no mechanism to close an account and accept the fee debt loss — the user is forced to watch their capital drain.

### Recommendation

Allow `close_account` to proceed even with negative fee_credits by forgiving the remaining debt (writing it off as the fee equivalent of bad debt). Alternatively, add a `force_close_with_fee_write_off` path that lets users exit at the cost of their remaining fee debt.

---

## Finding D: Partial Liquidation Can Cascade Into Full Close (MEDIUM)

### Summary

After a partial liquidation closes part of a position, the safety check at ~line 1980 immediately recalculates equity. Because the partial close realized negative mark PnL (which reduced capital), the remaining position may now be below the liquidation buffer target, triggering an immediate second full liquidation in the same transaction. This "double-hit" can close a position that would have survived with just the partial liquidation.

### Root Cause

**File:** `/home/anatoly/percolator/src/percolator.rs`

The liquidation flow:

1. `touch_account_for_liquidation` (~line 1949): settles mark PnL, updates entry_price to oracle
2. `compute_liquidation_close_amount` (~line 1956): calculates partial close amount based on post-settlement equity
3. `oracle_close_position_slice_core` (~line 1811-1842): executes partial close, realizes proportional mark PnL, then calls `settle_warmup_to_capital` which drains capital for negative PnL
4. Safety check (~line 1980-1993):
   ```rust
   if !self.accounts[idx].position_size.is_zero() {
       let target_bps = maintenance_margin_bps + liquidation_buffer_bps;
       if !self.is_above_margin_bps_mtm(&self.accounts[idx], oracle_price, target_bps) {
           let fallback = self.oracle_close_position_core(idx, oracle_price)?;
       }
   }
   ```

The double-hit chain:
- Partial close computes proportional mark_pnl for the closed slice (~line 1812)
- `settle_warmup_to_capital` (~line 1842) realizes the negative PnL by draining capital (~line 2953-2966)
- The safety check re-evaluates margin using the now-reduced capital
- If the capital reduction from settling the partial close drops equity below the buffer, a full liquidation fires immediately

### Impact

Positions near the liquidation boundary can be fully closed when a partial liquidation would have been sufficient. The extra close is more punitive than necessary — the user loses their entire position instead of having a reduced but surviving position.

This is arguably a conservative safety feature (better to fully close than leave an undercollateralized position), but it means the partial liquidation path in `compute_liquidation_close_amount` is misleading — it computes a "safe" partial size that turns out not to be safe after settlement effects.

### Recommendation

The safety fallback at line ~1988 is reasonable as a defense-in-depth measure. However, `compute_liquidation_close_amount` should account for the capital drain that will occur when mark PnL is settled during the partial close, so the computed close amount actually achieves the target margin.

---

## Finding E: pending_epoch Wraparound — NOT APPLICABLE

**Status: Does not exist in current codebase**

The `pending_epoch` field and associated ADL exclusion mechanism are not implemented in the current version of percolator.rs. A commented-out regression test in `/home/anatoly/percolator-prog/tests/integration.rs` (line ~954) documents this as a hypothetical "Bug #7" for a u8 epoch type that would wrap after 256 sweeps, but the feature was never shipped. No action needed.

---

## Finding F: Oracle Authority Has No Price Bounds or Deviation Checks (HIGH)

### Summary

The `PushOraclePrice` instruction accepts any positive u64 price with no upper bound, no deviation limit from the previous price or from Pyth/Chainlink, no rate limiting, and no circuit breaker. If the oracle authority key is compromised, an attacker can set arbitrary prices and trigger mass liquidations, manipulate withdrawals, or drain the insurance fund.

### Root Cause

**File:** `/home/anatoly/percolator-prog/src/percolator.rs`

The PushOraclePrice handler (~line 3213-3242):
```rust
// Validate price (must be positive)
if price_e6 == 0 {
    return Err(PercolatorError::OracleInvalid.into());
}

// Store the new price
config.authority_price_e6 = price_e6;
config.authority_timestamp = timestamp;
```

**Only validation:** `price_e6 != 0`

**Missing validations:**

| Check | Pyth | Chainlink | Authority |
|-------|------|-----------|-----------|
| Price > 0 | Yes | Yes | Yes |
| Max price bound | N/A (u64 range) | N/A | **Missing** |
| Confidence/quality filter | Yes (`conf_filter_bps`, ~line 1648) | No | **Missing** |
| Staleness on push | N/A | N/A | **Missing** (only checked on read) |
| Timestamp sanity | N/A | N/A | **Missing** (accepts any i64) |
| Deviation from previous | No | No | **Missing** |
| Rate limiting | N/A | N/A | **Missing** |

### Price Consumption Path

`read_price_with_authority` (~line 1850) tries the authority price FIRST before falling back to Pyth/Chainlink:
```rust
if let Some(authority_price) = read_authority_price(config, now_unix_ts, config.max_staleness_secs) {
    return Ok(authority_price);
}
// Fall back to Pyth/Chainlink
```

The authority price takes priority. `read_authority_price` (~line 1822) only checks staleness — no bounds or quality filters.

### Attack Scenarios (if oracle authority compromised)

1. **Mass liquidation**: Push price to 1 (minimum). All LONG positions become massively underwater, triggering cascading liquidations. Insurance fund drains, losses socialize.

2. **Inflated withdrawals**: Push price extremely high. LONG positions show massive unrealized profit. Attacker withdraws inflated equity before price corrects.

3. **Insurance drain**: Alternate between extreme high and low prices. Each swing liquidates one side of the book, consuming insurance for bad debt absorption.

4. **Timestamp manipulation**: Push with future timestamp to keep a stale price "fresh" for longer than max_staleness_secs intended.

### Mitigating Factors

- Oracle authority requires admin to set (`SetOracleAuthority` requires admin signer, ~line 3202)
- Staleness checked on read (~line 1836): prices expire after `max_staleness_secs`
- Authority can be disabled by setting to all-zeros

### Recommendation

1. Add MAX_ORACLE_PRICE bound check on push (the core engine already has `MAX_ORACLE_PRICE = 1_000_000_000_000_000` at line 63)
2. Add deviation check: reject prices that differ by more than X% from the last pushed price
3. Add timestamp validation: reject if `timestamp > now + buffer` or `timestamp < now - max_staleness_secs`
4. Consider requiring multi-sig or timelock for `SetOracleAuthority` changes

---

## Resolved Issues (for reference)

The following issues were previously documented and have been fixed:

- **Stranded vault funds after socialized loss** — Fixed by PR #15 (`bb9474e`): automatic recovery via `recover_stranded_to_insurance()`
- **Warmup budget double-subtraction** — Fixed by commit `5f5213c`: corrected `warmup_budget_remaining()` formula
- **Recovery over-haircut confiscating LP profit** — Fixed by commit `19cd5de`: haircut limited to `loss_accum` instead of `stranded + loss_accum`
