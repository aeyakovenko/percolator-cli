# Finding: Insurance Fund Drain via Adversarial Self-Trading

**Severity: HIGH**
**Status: OPEN**
**Program: BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw (immutable, upgrade authority burned)**
**Market: 5ZamUkAiXtvYQijNiRcuGaea66TVbbTPusHfwMX1kTqB (all admin keys burned)**

## Summary

An attacker controlling two accounts (LP + User) can open maximum-leverage opposite positions, wait for natural oracle price volatility, then selectively liquidate the losing side. The insurance fund covers the losing side's deficit, and the winning side extracts the insurance subsidy as profit. The attack profits from price movement in **either direction** since the attacker controls both sides.

The insurance fund is a shared commons with no ownership-correlation tracking. The engine explicitly treats all accounts identically regardless of ownership (`kind` is non-normative per `percolator.rs:312-315`). There is no mechanism to detect or prevent one entity from controlling both counterparties of a trade.

## Root Cause

Three design properties combine to create this vulnerability:

1. **Insurance is ownership-blind** (`percolator.rs:2291-2301`, `use_insurance_buffer`): When a liquidation produces a deficit D, insurance covers `min(D, insurance_balance)` with no check on who caused the deficit or who benefits from it.

2. **Liquidation timing is attacker-controlled**: `LiquidateAtOracle` is permissionless (anyone can call it), and the engine does NOT enforce `max_crank_staleness_slots` (`percolator.rs:436` — parameter stored but never checked). The attacker decides exactly when to trigger liquidation.

3. **Haircut bypass when insurance covers the full deficit** (`percolator.rs:2801-2818`): When `Residual >= pnl_matured_pos_tot`, the haircut ratio h = 1. Insurance coverage maintains h = 1, which in turn triggers instant warmup acceleration (`percolator.rs:1327-1384`, `admit_outstanding_reserve_on_touch`), allowing the winning side to immediately convert PnL to withdrawable capital.

## Concrete Attack on Mainnet Market

### Market Parameters (from README)

```
Insurance fund:           5 SOL
tvlInsuranceCapMult:      20 (max c_tot = 20 * insurance)
initial_margin_bps:       2000 (20% = 5x max leverage)
maintenance_margin_bps:   1000 (10%)
trading_fee_bps:          10 (0.10%)
new_account_fee:          57,000,000 lamports (~0.057 SOL)
Oracle:                   Pyth SOL/USD (continuous updates)
```

### Prerequisites

- Deploy a standard matcher program (e.g., fork percolator-match with 50bps spread)
- Two Solana wallets (or one wallet controlling both accounts)
- Working capital: ~25 SOL (returned minus fees)

### Step-by-Step Attack

```
Phase 1: Setup (~4 transactions)
  1. Deploy matcher program to Solana
  2. InitLP (Account A) — fee: 0.057 SOL → insurance
  3. InitUser (Account B) — fee: 0.057 SOL → insurance
  4. Deposit 10 SOL to LP (Account A)
  5. Deposit 10 SOL to User (Account B)

Phase 2: Open Positions (1 transaction)
  6. TradeCpi: User goes LONG 50 SOL notional (5x leverage)
     LP takes SHORT 50 SOL notional (counterparty)
     Trading fees: ~0.05 SOL per side → insurance

Phase 3: Wait for Volatility (passive)
  7. Wait for SOL/USD to move >20% in either direction
     At 30% move, insurance extraction is maximized
     No action needed — Pyth oracle updates continuously
     Window: up to 48 hours (permissionlessResolveStaleSlots)

Phase 4: Liquidate + Extract (~3 transactions)
  8. Call LiquidateAtOracle on the LOSING account
     - If SOL dropped 30%: LP (short) profited, User (long) bankrupt
     - If SOL rose 30%: User (long) profited, LP (short) bankrupt
     - Deficit D = 5.05 SOL → insurance covers in full
     - Insurance drops from ~5.2 to ~0.16 SOL

  9. Winning side: warmup accelerates (h=1), PnL converts to capital
     Withdraw 14.95 SOL (equity 24.95 minus 10 SOL margin hold)

Phase 5: Unwind Position (~6 transactions)
  10. TopUpInsurance with ~1 SOL (permissionless, unlocks TVL deposit cap)
  11. InitLP2, deposit ~13 SOL (margin for closing trade)
  12. Trade to close winning account's position
  13. Close winning account → recover ~10 SOL capital
  14. Unwind LP2 position (create User2, counter-trade, close both)
  15. Recover all unwind capital minus fees
```

### Economics

```
Attacker's sunk costs:
  - Init fees (4 accounts):              0.228 SOL
  - Trading fees (3 round-trips):        0.30 SOL
  - Insurance top-up (unwind unlock):    1.00 SOL
  - Maintenance fees:                    ~0.01 SOL
  Total sunk:                            ~1.54 SOL

Insurance drained:                       ~5.05 SOL

Net attacker profit:                     ~3.5 SOL (from 5 SOL insurance)
```

The attack extracts approximately **70% of the insurance fund**.

### Direction-Agnostic Property

The attacker profits from a >20% price move in **either direction**:

- SOL rises 30%: LP (short) bankrupt → insurance covers LP deficit → User (long) profits
- SOL drops 30%: User (long) bankrupt → insurance covers User deficit → LP (short) profits

The attacker controls both sides, so they always own the winning account. This makes the attack a pure volatility play with the insurance fund as the counterparty.

## Mathematical Proof

Given:
- D = capital deposited per side
- p = oracle price move fraction (e.g., 0.30 = 30%)
- L = leverage = 5x
- f = total friction (fees, costs) ≈ 1.5 SOL

Attack profit:
```
profit = D * (L*p - 1) - f     [for p > 1/L = 20%]
```

Insurance drain:
```
insurance_drain = D * (L*p - 1) [capped at insurance_balance]
```

| Price Move | D = 10 SOL | D = 5 SOL |
|-----------|------------|-----------|
| 21%       | 0.5 - f   | 0.25 - f |
| 25%       | 2.5 - f   | 1.25 - f |
| 30%       | 5.0 - f   | 2.5 - f  |
| 40%       | 10.0 - f  | 5.0 - f  |

With f ≈ 1.5 SOL, the attack is profitable for p ≥ ~24% with D = 10 SOL.

## Code References

| Component | File | Line | Role |
|-----------|------|------|------|
| Insurance deficit coverage | percolator.rs (engine) | 2426 | `use_insurance_buffer(d)` — insurance-first |
| Insurance buffer drain | percolator.rs (engine) | 2291-2301 | `min(loss, ins_bal)` — no ownership check |
| Haircut ratio | percolator.rs (engine) | 2801-2818 | h = Residual/pnl_matured when insurance keeps h=1 |
| Warmup acceleration | percolator.rs (engine) | 1327-1384 | Instant release when h=1 post-insurance |
| LiquidateAtOracle | percolator.rs (prog) | 6312-6406 | Permissionless, no timing restriction |
| TopUpInsurance | percolator.rs (prog) | 6568-6640 | Permissionless, unlocks TVL cap |
| TVL deposit cap | percolator.rs (prog) | 4923-4933 | `c_tot <= mult * insurance` — drops with insurance |
| Account kind non-normative | percolator.rs (engine) | 312-315 | Engine ignores User vs LP distinction |
| Crank staleness NOT enforced | percolator.rs (engine) | 436 | Parameter stored but never gate-checked |

## Amplifying Factors

1. **KeeperCrank rewards are always zero** (security.md Finding F5): No economic incentive for third-party keepers. The attacker is likely the only crank operator, giving them full control over liquidation timing.

2. **No oracle manipulation needed**: The attack relies on natural SOL/USD volatility. SOL has moved >20% within 48-hour windows multiple times in 2025-2026.

3. **The market is empty**: No other participants exist. The attacker operates unopposed with no interference from third-party liquidators or keepers.

4. **Repeatable**: After extracting insurance, the attacker can top up a small amount and repeat with reduced positions. Each cycle extracts `min(profit, remaining_insurance)`.

## Recommendations

### Short-term (if program were upgradable)

1. **Correlation detection**: Track account owners across LP and User slots. Flag or block trades where both counterparties share an owner (or are funded from the same source within N slots).

2. **Enforce crank freshness for liquidation**: Require `last_crank_slot + max_crank_staleness >= current_slot` before allowing `LiquidateAtOracle`. This forces regular crank cadence and prevents delayed-liquidation exploitation.

3. **Insurance withdrawal cooldown on deficit events**: After insurance covers a deficit, impose a cooldown before any account can withdraw capital or convert PnL.

### Long-term

4. **Time-weighted insurance utilization**: Track cumulative insurance utilization per owner address. Rate-limit how much insurance any single entity can consume.

5. **Mandatory crank participation**: Require active accounts to crank periodically (or delegate to a keeper) as a condition for holding positions.

6. **Insurance fund segregation**: Segregate insurance by "vintage" — new deposits are backed by insurance accumulated after their entry, not legacy insurance from before.

## Disclosure

This finding is submitted per the public bug bounty posted by @toly:
> "Figure out how to hack it or manipulate the engine and steal the 5 sol"
> https://x.com/toly/status/2047044914438111738

The program is immutable with burned admin keys. No code modification is possible. This finding describes a design-level vulnerability in the insurance fund's ownership-blind deficit coverage mechanism.
