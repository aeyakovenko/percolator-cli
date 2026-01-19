# Percolator Security Audit - Live Devnet Market

## Objective
Test the security claim: **Even with oracle control, an attacker cannot withdraw more than user realized losses plus insurance surplus.**

## Market Configuration
- **Slab**: `Dw9f3yYUuP6mqLBpjEqBag9caw44GD4t9F5kaSuUTheq`
- **Program**: `2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp`
- **Type**: Inverted SOL/USD (collateral in SOL)
- **Oracle**: Chainlink + Oracle Authority override

## Audit Status

### Phase 1: Market Setup Verification
- [ ] Verify market is inverted
- [ ] Verify oracle authority control
- [ ] Check vault balance
- [ ] Check insurance fund balance
- [ ] Document initial state

### Phase 2: Attack Vectors to Test
1. **Oracle Manipulation Attacks**
   - [ ] Flash crash to trigger liquidations
   - [ ] Price pump to inflate profits
   - [ ] Zero price attack (should be rejected)
   - [ ] Extreme price swing oscillations

2. **Withdrawal Attacks**
   - [ ] Attempt to withdraw more than capital
   - [ ] Withdraw after price manipulation
   - [ ] Attempt double-withdrawal

3. **Position Manipulation**
   - [ ] Create position, manipulate price, close
   - [ ] Try to extract LP collateral via bad trades
   - [ ] Funding rate manipulation

4. **Insurance Fund Attacks**
   - [ ] Attempt to drain insurance via bad debt
   - [ ] Create cascade of liquidations

### Phase 3: Results
(To be filled in as tests complete)

---

## Audit Log

### 2026-01-19 - Session Start
- Starting security audit of live devnet market
- Checking market configuration...

#### Initial State Snapshot
```
Market: Inverted SOL/USD
Oracle Authority: ACTIVE (A3Mu2n...)
Oracle Price: $140.00

Risk Parameters:
- Maintenance Margin: 5%
- Initial Margin: 10%
- Trading Fee: 10 bps
- Liquidation Fee: 100 bps

Balances:
- Vault: 4.506039280 SOL
- Insurance Fund: 1.003000000 SOL
- Total Liability: 4.504000000 SOL
- Surplus: 0.002039280 SOL

Accounts:
- 1 LP with 1.001 SOL capital
- 2 Users with 2.5 SOL total capital
- 0 open positions

Status: SOLVENT
```

**Verification Complete:**
- [x] Market is inverted (SOL collateral)
- [x] Oracle authority is active and controlled
- [x] Vault is solvent

**Next:** Set up test positions for attack scenarios

---

### Audit Session 2 - Oracle Manipulation Tests

#### Attack Tests Executed

**1. Zero Price Attack**
- Result: REJECTED
- Notes: Program correctly rejects zero price

**2. Withdrawal Overflow Attack**
- Result: REJECTED
- Notes: Cannot withdraw more than available

**3. Oracle Profit Extraction**
- Opened 1M unit LONG position at $150
- Manipulated price to $300 (simulating 50% SOL crash)
- Closed position with +0.147 SOL profit
- **Withdrawal of profit: BLOCKED** (error 0xd)

#### Critical Finding: Withdrawal Limits

Binary search found maximum withdrawable amount:
```
Account 1 (USER):
  Capital: 1.998 SOL
  PnL: +0.147 SOL
  Max Withdrawable: 0.244 SOL (12.19% of capital!)

Account 0 (LP):
  Capital: 0.244 SOL (down from 1.001 SOL)
```

**Key Observation:** Withdrawal limit equals LP's remaining capital.

#### Current Balance Check
```
Vault: 3.895 SOL
Insurance: 1.003 SOL
Total Liabilities: 3.893 SOL
Status: SOLVENT (surplus: 0.002 SOL)

User wrapped SOL balance: 15.678 SOL (received previous withdrawals)
```

**Analysis in progress:** Investigating why user can only withdraw 12% of capital
