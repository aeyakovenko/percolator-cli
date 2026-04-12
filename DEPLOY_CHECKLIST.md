# Pre-Production Deployment Checklist

Two test suites verify the protocol on-chain. Both require `SOLANA_RPC_URL` in `.env`.

```bash
# 1. Preflight — 93 checks, 25 sections, 3 market types (Pyth, Hyperp, Inverted)
#    ~24 SOL for multi-slab rent (reclaimed at end)
npx tsx tests/preflight.ts

# 2. Live state verification — 105 checks, 9 sections, exhaustive before/after diffs
#    ~8 SOL for single slab (reclaimed at end)
npx tsx scripts/live-verify.ts

# 3. Unit tests — offline, no SOL needed
pnpm test
```

---

## Preflight (`tests/preflight.ts`) — 93 checks

Exercises every major feature across 3 market configurations. Focuses on behavioral correctness and conservation invariants.

### 1. Program Deployment (1)
- [x] Program accessible and executable on cluster

### 2. Market Lifecycle (6)
- [x] InitMarket: slab=8951296 bytes, instruction data=352 bytes
- [x] Header: magic=PERCOLAT, admin=signer
- [x] Config: all fields including insurance/resolution fields
- [x] Params: all 15 risk params exact match
- [x] Engine: vault=0, insurance=0, numUsed=0, currentSlot from clock
- [x] **Conservation: SPL vault balance === engine.vault**

### 3. Oracle & Price Authority (3)
- [x] SetOracleAuthority: read-back confirms
- [x] PushOraclePrice: authorityPriceE6 and timestamp match
- [x] SetOraclePriceCap: cap value read-back

### 4. Account Creation (4)
- [x] KeeperCrank permissionless
- [x] InitUser (6 accounts w/ clock): kind=0, owner verified
- [x] InitLP w/ matcher (6 accounts w/ clock): kind=1, context 320b
- [x] **Conservation check**

### 5. Capital Operations (6)
- [x] Deposit user: **exact delta = amount**
- [x] Deposit LP: **exact delta = amount**
- [x] Engine vault + cTot reflect deposits
- [x] TopUpInsurance: balance increases
- [x] Withdraw: **exact capital delta + vault delta = amount**
- [x] **Conservation check**

### 6. Trading — TradeNoCpi (5)
- [x] Trade succeeds after warmup
- [x] User positionBasisQ non-zero
- [x] LP positionBasisQ = -user (exact mirror)
- [x] **LP feesEarnedTotal > 0** (fee collected)
- [x] **Conservation check**

### 7. Trading — TradeCpi (2)
- [x] TradeCpi through matcher CPI succeeds
- [x] **Conservation check**

### 8. Price Movement & PnL (2)
- [x] Oracle applied: equity reflects price direction
- [x] **Engine pnlPosTot or pnlMaturedPosTot > 0**

### 9. Liquidation (5)
- [x] User opens position, price moved adversely
- [x] LiquidateAtOracle instruction accepted
- [x] Engine liquidation tracking accessible
- [x] **Conservation check**

### 10. Bank Run (5)
- [x] Close position + CloseAccount
- [x] Liquidated user closed
- [x] numUsedAccounts decrements
- [x] **Conservation check**

### 11. Market Resolution (5)
- [x] ResolveMarket: header.resolved = true
- [x] Crank force-closes positions
- [x] AdminForceCloseAccount removes all accounts
- [x] WithdrawInsurance: balance = 0
- [x] **Conservation check**

### 12. UpdateConfig (1)
- [x] Funding params persist on read-back

### 13. State Parsing Integrity (3)
- [x] parseAllAccounts/parseUsedIndices empty after lifecycle
- [x] InsuranceFund: only balance (no feeRevenue)
- [x] Engine ADL fields readable

### 14. Error Handling (2)
- [x] Duplicate InitMarket rejected (0x2)
- [x] Over-withdrawal rejected

### 15. Confirmed Liquidation — Hyperp (10)
- [x] Init Hyperp market (all-zeros feedId, mark=$100)
- [x] **Overleveraged trade rejected**
- [x] **Over-withdrawal rejected**
- [x] User opens leveraged position (800K units via TradeCpi)
- [x] **Close account with open position rejected**
- [x] Record pre-liquidation insurance balance
- [x] Crash mark to $10, index converges, crank sweeps
- [x] **Price impact verified: capital decreased from drop**
- [x] **Insurance and capital state after crash**
- [x] **Conservation check**

### 16. Bank Run — Hyperp (4)
- [x] 3 users deposit 20 tokens each
- [x] All close simultaneously (3+ closures)
- [x] **Vault decreased by >= 55M** (vault arithmetic)
- [x] **Conservation check**

### 17. Inverted Market (6)
- [x] Init Hyperp market with invert=1
- [x] Trade succeeds, position non-zero
- [x] LP mirrors user position
- [x] Close position via reverse trade
- [x] Close all accounts
- [x] **Conservation check**

### 18. Non-Admin Rejection (2)
- [x] **UpdateAdmin by random signer rejected**
- [x] **SetOracleAuthority by random signer rejected**

### 19. Unit Scale (3)
- [x] InitMarket encodes unitScale correctly
- [x] InitMarket encodes unitScale=0 (default) correctly
- [x] parseConfig reads unitScale from on-chain slab

### 20. Funding Rate — Hyperp (3)
- [x] Push mark=$150 (50% premium), crank to generate funding
- [x] **adlCoeffLong/Short change** (funding accrued to coefficients)
- [x] **Conservation check**

### 21. ADL + DrainOnly Mode (2)
- [x] Crash 95%, trade at crashed price, crank → capital or oracle state changes
- [x] **Conservation check**

### 22. Settlement & Fee Operations (5)
- [x] **QueryLpFees** returns data for LP (read-only simulation)
- [x] **SettleAccount** on user succeeds (permissionless PnL settlement)
- [x] **DepositFeeCredits** accepted or rejected (no fee debt confirmation)
- [x] **ConvertReleasedPnl** accepted or rejected (no released PnL confirmation)
- [x] **Conservation check**

### 23. Permissionless Resolution & ForceClose (3)
- [x] **ResolvePermissionless** rejected (oracle not stale enough — error confirmation)
- [x] **ForceCloseResolved** closes accounts permissionlessly after resolution
- [x] **ReclaimEmptyAccount** rejected on resolved market (confirmed)

### 24. Insurance Withdraw Policy (3)
- [x] **SetInsuranceWithdrawPolicy** succeeds, policyConfigured flag set
- [x] **WithdrawInsuranceLimited** withdraws within rate limits
- [x] **Conservation check**

### 25. Chainlink Oracle (2)
- [x] Chainlink oracle account accessible
- [x] Chainlink feed ID encoding is valid

---

## Live State Verification (`scripts/live-verify.ts`) — 100 checks

Exhaustive **before/after state diffs** on every parsed field. This catches offset regressions, missing field updates, and silent state corruption that the preflight's behavioral checks might miss.

### 1. InitMarket — 44 checks
Every field in header, config, params, and engine verified at exact expected value:
- Header: magic, version, admin, resolved=false, nonce=0
- Config: mint, vault, bump, confFilter, invert, unitScale, fundingHorizon, maxMaintenanceFee, maxInsuranceFloor, resolutionSlot, markEwma, forceCloseDelay
- Params: all 15 fields (warmup, mm, im, tradingFee, maxAccounts, newAccountFee, maintenanceFee, maxCrankStaleness, liqFeeBps, liqFeeCap, minLiqAbs, minDeposit, minMm, minIm, insuranceFloor)
- Engine: vault=0, insurance=0, currentSlot>0, fundingRate=0, lastCrankSlot, cTot=0, pnlPosTot=0, numUsed=0, nextAccountId, lifetimeLiqs=0, adlMultLong=1M, sideMode=Normal
- Conservation: SPL=0

### 2. Oracle + Crank — 5 checks
- **lastCrankSlot increments** (before < after)
- **lastOraclePrice set** (>0)
- **currentSlot advances** (before <= after)
- authorityPriceE6 = pushed value
- oracleAuthority = set authority

### 3. InitUser + InitLP — 12 checks
- **numUsedAccounts increments** (0→2)
- **bitmap[0] and bitmap[1] set** (isAccountUsed)
- **nextAccountId advances** (before < after)
- LP: kind=1, accountId, owner=payer, matcherProgram≠0, matcherContext≠0
- User: kind=0, accountId>LP, owner=payer
- vault: fee tokens received

### 4. Deposit — 6 checks
- **LP capital delta = exact deposit amount**
- **User capital delta = exact deposit amount**
- **engine.vault delta = 2×deposit**
- **cTot increases**
- **SPL balance delta = 2×deposit**
- **Conservation: engine.vault === SPL balance**

### 5. TopUpInsurance — 4 checks
- **insurance delta = exact amount**
- **vault delta = exact amount**
- **SPL delta = exact amount**
- **Conservation: engine.vault === SPL balance**

### 6. Trade (TradeCpi) — 6 checks
- **User position increases** (positionBasisQ before→after)
- **LP position mirrors** (opposite sign, before→after)
- **Positions sum to zero** (userDelta + lpDelta = 0)
- **User capital decreases** (fees paid)
- **LP feesEarnedTotal increases** (fees earned)
- **Conservation: engine.vault === SPL balance**

### 7. Withdraw — 5 checks
- **User capital delta = exact withdraw amount**
- **engine.vault delta = exact withdraw amount**
- **SPL delta = exact withdraw amount**
- **cTot decreases**
- **Conservation: engine.vault === SPL balance**

### 8. Bank Run — 5 checks
- **User position closed to 0** (reverse trade)
- **numUsedAccounts decremented** (before - 1)
- **Account closed** (numUsed confirms)
- **vault decreased** (capital returned to user)
- **cTot decreased**
- **Conservation: engine.vault === SPL balance**

### 9. Resolve + ForceClose + Close — 8 checks
- **header.resolved = true**
- **config.resolutionSlot > 0** (set to current slot)
- **All accounts closed** (parseUsedIndices empty)
- **numUsedAccounts = 0**
- **bitmap[0] cleared** (LP force-closed)
- **insurance = 0** (withdrawn)
- **vault = 0** (fully drained)
- **SPL = 0** (final conservation)
- Slab closed, rent reclaimed

---

## Coverage Matrix

| Feature | Preflight (behavioral) | Live-verify (state diff) |
|---------|----------------------|--------------------------|
| InitMarket fields | Config/params spot-checked | **Every field at exact value** |
| Crank state | Slot > 0 | **lastCrankSlot before/after** |
| Account creation | Kind + owner | **Bitmap, numUsed, nextAccountId** |
| Deposit/Withdraw | Exact delta | **Exact delta + cTot + SPL** |
| Trade | Position non-zero + mirror | **Position delta sum=0, capital delta, fees delta** |
| Bank run | numUsed + vault decrease | **numUsed decrement, cTot decrease, vault drain** |
| Resolution | resolved flag | **resolutionSlot, bitmap clear, vault=0, SPL=0** |
| Insurance | Balance > 0 | **Exact delta on topup** |
| Conservation | 15 checkpoints | **After every mutation** |

**Totals: 93 preflight + 105 live-verify + 5 unit test suites = 198+ automated checks**
