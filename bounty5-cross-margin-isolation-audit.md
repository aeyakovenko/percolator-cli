# Bounty 5: Cross-Margin Insurance Isolation Audit

## Win Condition

> Cause `engine.insurance_fund.balance` to drop below its current value via any
> sequence of public-instruction calls.

**Constraints**: Pyth manipulation and validator attacks are out of scope.

## Methodology

1. Full source review of `percolator/src/v16.rs` (~20K lines, risk engine)
2. Full source review of `percolator-prog/src/v16_program.rs` (~11K lines, Solana program)
3. Full source review of `percolator/src/wide_math.rs` (math library)
4. Analysis of all instruction paths that modify `header.insurance`
5. Analysis of cross-margin equity computation and source credit system
6. Analysis of permissionless market creation and domain budget initialization
7. Analysis of force-close, recovery, and forfeit paths
8. Analysis of conservation invariants and stock reconciliation proofs
9. Analysis of EWMA mark manipulation bounds via TradeNoCpi

## System Architecture

Percolator v16 is a multi-market perpetual futures engine on Solana. A single
"slab" (market group account) holds N markets, each with its own oracle and
isolated insurance domain budgets. Portfolios are cross-margined: positive PnL
in one market can offset losses in another, subject to source credit haircuts.

### Key Invariants

- `TokenValueFlowProofV16::validate()` — per-operation debits == credits
- `StockReconciliationProofV16::validate()` — c_tot + insurance + backing == vault
- `assert_public_invariants()` — post-conditions on every instruction
- `insurance <= vault` (always enforced)
- `insurance_domain_spent[d] <= insurance_domain_budget[d]` for all domains

### Insurance Isolation Model

- Global `insurance` balance is a single u128
- Each market has 2 domain budgets (long/short) tracking spending limits
- Actual spend per domain: `min(global_insurance, budget - spent)`
- Permissionless markets start with budget = 0 (no insurance access)
- Budgets grow from: maintenance fees, trade fees, permissionless init fees
- 20% of non-zero-market trade fees redirect to market 0's budget

---

## Findings

### Finding 1: Domain Budget Dilution via Permissionless Market Spam

**Severity**: Low (griefing, not direct insurance drain)

**Location**: `v16_program.rs:4198` (`credit_maintenance_fee_to_active_market_budgets_view`)

**Description**: Maintenance fees are split equally across all active markets.
Adding permissionless markets dilutes existing markets' share of maintenance fee
budget growth. With `permissionless_market_init_fee` doubling every 32 markets
(line 3596), the cost grows exponentially, but the first 32 markets each cost
only ~$0.50.

**Impact**: Reduces the rate at which established markets (0, 1, 2) accumulate
domain budget. If a legitimate bankruptcy occurs later, less domain budget is
available to cover it. This doesn't directly drain insurance.

**Mitigation present**: Exponential fee scaling limits spam. Admin can set
`free_market_slot_count = 0` to disable permissionless appends.

---

### Finding 2: AuthMark Push Not Gated by Recovery/Stale State

**Severity**: Informational

**Location**: `v16_program.rs:4279` (`require_asset_mark_pushable_view`)

**Description**: `PushAuthMark` (tag 63) only checks asset lifecycle (2=active
or 3=drain_only). It does NOT check `loss_stale_active`, `bankruptcy_hlock_active`,
or `threshold_stress_active`. A permissionless market creator with oracle authority
can push marks even during problematic market states.

**Impact**: Limited. The mark push only affects the specific asset's
`mark_ewma_e6` and `oracle_target_price_e6`. The crank rate-limiter
(`max_price_move_bps_per_slot`) bounds how fast the engine's effective price
can move toward the pushed target. The mark itself doesn't bypass insurance
domain isolation.

---

### Finding 3: Source Credit Rate Correctly Bounds Cross-Margin Profit

**Severity**: N/A (defense confirmed working)

**Location**: `v16.rs:5710` (`account_source_realizable_support`)

**Description**: Positive PnL from a controlled market X is properly haircutted
before it can support equity in other markets. The `credit_rate =
available_backing / positive_claim_bound` dynamically adjusts. When a market's
counterparty side has insufficient backing (e.g., after manipulation), the credit
rate drops, reducing realizable profit.

**Key defense chain**:
1. `set_account_pnl_inner` attributes PnL increases to source domains (line 6304)
2. `account_source_realizable_support` computes bounded support (line 5710)
3. `account_haircut_equity` uses bounded support for equity (line 6213)
4. Insurance consumption checks this equity at liquidation time

---

### Finding 4: Bankrupt Portfolio Must Close All Legs Before Insurance

**Severity**: N/A (defense confirmed working)

**Location**: `v16.rs:9352`

**Description**: When a portfolio's loss exceeds capital AND it still has active
positions in other markets, the engine triggers `RecoveryRequired` instead of
proceeding with partial liquidation. This prevents selective insurance extraction
where an attacker liquidates one market while holding unrealized profit in another.

---

### Finding 5: Permissionless Markets Start with Zero Insurance Budget

**Severity**: N/A (defense confirmed working)

**Location**: `v16_program.rs:4191` (`clear_asset_domain_budget_counters_view`)

**Description**: When a market is permissionlessly activated, both domain budgets
are set to 0. `available_domain_insurance = min(insurance, 0) = 0`. No insurance
can be consumed from a new market's domains until the budget grows from trading
fees. The permissionless market init fee goes to market 0's budget (line 7732),
not the new market's budget.

---

### Finding 6: Fee Redirect Does Not Create Phantom Insurance

**Severity**: N/A (defense confirmed working)

**Location**: `v16_program.rs:4129` (`credit_fee_to_domain_budget_view`)

**Description**: The 20% fee redirect from non-zero markets to market 0 only
inflates market 0's budget counter. It does not create new insurance atoms.
Insurance only increases when capital is transferred via fee collection
(`charge_account_fee_current_not_atomic`, line 9896). The budget is merely a
spending limit.

---

### Finding 7: Force-Close and Recovery Paths Are Well-Defended

**Severity**: N/A (defense confirmed working)

**Locations**:
- `ForceCloseAbandonedAsset` (tag 64): Uses frozen `effective_price` at shutdown
- `ForfeitRecoveryLeg` (tag 43): Bounded by domain budgets, doesn't reduce vault
- `CureAndCancelClose` (tag 42): Requires NO irreversible progress, adds to vault
- `RebalanceReduce` (tag 44): Only reduces positions, verifies risk decreases
- `ClaimResolvedPayoutTopup` (tag 46): Bounded by rate-limited payout schedule

**Key protections**:
- `ForceCloseAbandonedAsset` locks price at shutdown time, preventing stale-price exploitation
- `ForfeitRecoveryLeg` reduces `header.insurance` but NOT the vault (internal accounting only), bounded by `insurance_domain_spent <= insurance_domain_budget`
- All paths call `validate_shape()` or `assert_public_invariants()` at exit

---

### Finding 8: Missing validate_shape() in TradeNoCpi Path

**Severity**: Medium (invariant gap, no direct insurance drain)

**Location**: `v16_program.rs:4927-5062` (`handle_trade_nocpi_zero_copy`)

**Description**: The `TradeNoCpi` instruction handler (tag 6) does NOT call
`group.validate_shape()` after `execute_trade_with_fee_in_place_not_atomic`.
The engine's internal `validate_shape_audit_scan()` (line 9697) is compiled out
in production (`#[cfg(feature = "audit-scan")]`).

This means the global shape invariants (including `live_source_credit_insurance
<= insurance` and domain budget consistency) are not checked post-trade. The
trade itself only increases insurance (fees: capital → insurance), so this does
not directly enable insurance drainage. However, it allows inconsistent state to
persist if a previous operation (e.g., the no-cranker liquidation bug) already
broke invariants.

**Combined risk with v5h's no-cranker liquidation finding**: After a no-cranker
liquidation creates inconsistent state (insurance < reservation), subsequent
`TradeNoCpi` calls would succeed (no validate_shape to catch the broken state),
allowing the market to continue operating with violated invariants. This extends
the window of inconsistency.

**Fix**: Add after line 5056 in `handle_trade_nocpi_zero_copy`:
```rust
group.validate_shape().map_err(map_v16_error)?;
account_a.validate_with_market(&group.as_view()).map_err(map_v16_error)?;
account_b.validate_with_market(&group.as_view()).map_err(map_v16_error)?;
```

---

### Finding 9: validate_insurance_to_close_insurance_spent Is Vacuous

**Severity**: Low (defense-in-depth gap)

**Location**: `v16.rs:2695-2705` (`TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent`)

**Description**: This validation function accepts an `amount` parameter but
discards it with `let _ = amount;`. It only checks `vault_before == vault_after`
(which is trivially true since insurance consumption is internal accounting).
The function provides no actual validation of how much insurance was consumed
relative to domain budgets or reservations.

The actual budget check occurs in `consume_domain_insurance_for_negative_pnl`
via `available_domain_insurance()`, but this "proof" function is misleading —
it suggests a defense layer that doesn't actually validate anything about the
insurance spend amount.

---

### Finding 10: EWMA Mark Manipulation Is Rate-Limited (defense confirmed)

**Severity**: N/A (defense confirmed working)

**Location**: `v16_program.rs:10214` (`update_hybrid_mark_after_trade_view`)

**Description**: TradeNoCpi updates the EWMA mark via `exec_price`, but the update
is clamped by `max_price_move_bps_per_slot * 1` per trade. The crank computation
(`hybrid_effective_price_for_crank_view`, line 10121) further bounds the effective
price move to `max_price_move_bps_per_slot * max_accrual_dt_slots` per crank.
Walking the mark to an extreme value requires many trades over many slots.

---

### Finding 11: Math Layer Is Bulletproof

**Severity**: N/A (defense confirmed working)

**Location**: `percolator/src/wide_math.rs`

**Description**: All arithmetic uses checked operations. U256/U512 intermediates
prevent precision loss in multiply-divide chains. No wrapping or saturating in
critical paths. Fee credits are constrained to <= 0 (no sign flip). K overflow
requires ~170 billion cranks of maximum magnitude — infeasible.

---

## Attack Vector Deep-Dive: The Sugus Vector

The most discussed attack vector (from @Sugusdev's analysis):

1. Create market X with controlled oracle (AuthMark)
2. Take cross-margin positions: long X, short Y (real oracle market)
3. Push X's mark up → portfolio shows positive PnL from X
4. This PnL supports margin in Y → take larger Y position
5. Y moves adversely → liquidation consumes Y's insurance domain
6. Push X's mark to zero → X's profit evaporates

**Why this is defended**:

The source credit rate system (Finding 3) is the key defense. When X's
counterparty has insufficient backing to pay the inflated profit, the credit rate
drops. This reduces the "realizable" portion of X's profit before it can support
equity in Y. The haircut ensures that manipulated profits on X cannot fully
offset losses on Y.

Additionally:
- New market X starts with budget = 0 (Finding 5)
- Recovery gate prevents partial liquidation (Finding 4)
- Cross-market PnL attribution tracks source domains (v16.rs:6268)
- Risk epoch invalidation ensures credit rate is fresh at liquidation

---

## Recommended Test Plan (PoC Framework)

For anyone attempting to validate these defenses empirically:

```
1. Deploy v16 program on devnet
2. InitMarket → create market group with 2 markets (m0=Pyth, m1=AuthMark)
3. ConfigureAuthMark on m1 (give yourself oracle authority)
4. Create 2 portfolios (attacker + LP)
5. TradeNoCpi on m0 (real oracle) and m1 (controlled)
6. PushAuthMark on m1 to inflate attacker's PnL
7. Record insurance_fund.balance BEFORE
8. Crank m0 with adverse Pyth price → trigger liquidation
9. Record insurance_fund.balance AFTER
10. Assert: insurance AFTER >= insurance BEFORE
```

Key things to test:
- Source credit rate haircut under extreme manipulation
- Domain budget isolation when new market has 0 budget
- Recovery gate blocking selective liquidation
- EWMA rate limiting under rapid AuthMark pushes

---

## Conclusion

The Percolator v16 insurance isolation model is well-designed with multiple
overlapping defense layers:

1. **Domain budgets** (spending limits per market, starts at 0 for new markets)
2. **Source credit haircuts** (bounds profit realization from untrusted markets)
3. **Recovery gating** (forces all legs closed together, prevents selective extraction)
4. **Conservation proofs** (per-instruction flow validation + stock reconciliation)
5. **Rate limiting** (EWMA clamping bounds mark manipulation speed)
6. **Frozen prices** (force-close uses shutdown-time price, not stale mark)

**Actionable code bugs found** (defense-in-depth gaps):
- Missing `validate_shape()` in `handle_trade_nocpi_zero_copy` (Finding 8)
- Vacuous `validate_insurance_to_close_insurance_spent` proof function (Finding 9)
- Related: missing `validate_shape()` in no-cranker liquidation (see issue #73 by v5h)

These are real validation gaps that weaken defense-in-depth. The TradeNoCpi gap
(Finding 8) is novel and distinct from v5h's liquidation path gap. Together they
mean that both major mutation paths (trades AND liquidations) can leave the market
in unvalidated state on the live bounty deployment.

**No confirmed exploit satisfying the win condition.** The most promising attack
chain (budget dilution + no-cranker liquidation + validate_shape bypass) requires
building budget over time from maintenance fees (slow) or engineering a "real"
bankruptcy on an established market (requires oracle manipulation, out of scope).

The system's defense-in-depth approach means exploiting any single layer still
leaves multiple other layers blocking insurance extraction. A successful exploit
would need to simultaneously bypass: domain budgets, source credit haircuts,
conservation invariants, and the recovery gate.
