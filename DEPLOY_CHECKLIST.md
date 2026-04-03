# Pre-Production Deployment Checklist

Run `npx tsx tests/preflight.ts` — **84 automated checks** across **22 sections**.
Requires `SOLANA_RPC_URL` in `.env` and ~50 SOL for multi-slab rent.

## 1. Program Deployment (1)
- [x] Program accessible and executable on cluster

## 2. Market Lifecycle (6)
- [x] InitMarket: slab=1156800 bytes, instruction data=352 bytes
- [x] Header: magic=PERCOLAT, admin=signer
- [x] Config: all fields including 7 insurance/resolution fields
- [x] Params: all 16 risk params exact match
- [x] Engine: vault=0, insurance=0, numUsed=0, currentSlot from clock
- [x] **Conservation: SPL vault balance === engine.vault**

## 3. Oracle & Price Authority (3)
- [x] SetOracleAuthority: read-back confirms
- [x] PushOraclePrice: authorityPriceE6 and timestamp match
- [x] SetOraclePriceCap: cap value read-back

## 4. Account Creation (4)
- [x] KeeperCrank permissionless
- [x] InitUser (6 accounts w/ clock): kind=0, owner verified
- [x] InitLP w/ matcher (6 accounts w/ clock): kind=1, context 320b
- [x] **Conservation check**

## 5. Capital Operations (6)
- [x] Deposit user: **exact delta = amount**
- [x] Deposit LP: **exact delta = amount**
- [x] Engine vault + cTot reflect deposits
- [x] TopUpInsurance: balance increases
- [x] Withdraw: **exact capital delta + vault delta = amount**
- [x] **Conservation check**

## 6. Trading — TradeNoCpi (5)
- [x] Trade succeeds after warmup
- [x] User positionBasisQ non-zero
- [x] LP positionBasisQ = -user (exact mirror)
- [x] **LP feesEarnedTotal > 0** (fee collected)
- [x] **Conservation check**

## 7. Trading — TradeCpi (2)
- [x] TradeCpi through matcher CPI succeeds
- [x] **Conservation check**

## 8. Price Movement & PnL (2)
- [x] Oracle applied: equity reflects price direction
- [x] **Engine pnlPosTot or pnlMaturedPosTot > 0**

## 9. Liquidation — Pyth Market (5)
- [x] User opens position, price moved adversely
- [x] LiquidateAtOracle instruction accepted
- [x] Engine liquidation tracking accessible
- [x] **Conservation check**

## 10. Bank Run — Pyth Market (5)
- [x] Close position + CloseAccount
- [x] Liquidated user closed
- [x] numUsedAccounts decrements
- [x] **Conservation check**

## 11. Market Resolution (5)
- [x] ResolveMarket: header.resolved = true
- [x] Crank force-closes positions
- [x] AdminForceCloseAccount removes all accounts
- [x] WithdrawInsurance: balance = 0
- [x] **Conservation check**

## 12. UpdateConfig (1)
- [x] Funding params persist on read-back

## 13. State Parsing Integrity (3)
- [x] parseAllAccounts/parseUsedIndices empty after lifecycle
- [x] InsuranceFund: only balance (no feeRevenue)
- [x] Engine ADL fields readable

## 14. Error Handling (2)
- [x] Duplicate InitMarket rejected (0x2)
- [x] Over-withdrawal rejected

## 15. Confirmed Liquidation — Hyperp (10)
- [x] Init Hyperp market (all-zeros feedId, mark=$100)
- [x] **Overleveraged trade rejected**
- [x] **Over-withdrawal rejected**
- [x] User opens leveraged position (800K units via TradeCpi)
- [x] **Close account with open position rejected**
- [x] Record pre-liquidation insurance balance
- [x] Crash mark to $10, index converges, crank sweeps
- [x] **position=0, capital=0, lifetimeLiquidations>0** (confirmed wiped)
- [x] **Insurance fund balance changed** (fee charged)
- [x] **Conservation check**

## 16. Bank Run — Hyperp (4)
- [x] 3 users deposit 20 tokens each
- [x] All close simultaneously (3+ closures)
- [x] **Vault decreased by >= 55M** (vault arithmetic)
- [x] **Conservation check**

## 17. Inverted Market (invert=1) (6)
- [x] Init Hyperp market with invert=1
- [x] Trade succeeds, position non-zero
- [x] LP mirrors user position
- [x] Close position via reverse trade
- [x] Close all accounts
- [x] **Conservation check**

## 18. Non-Admin Rejection (2)
- [x] **UpdateAdmin by random signer rejected**
- [x] **SetOracleAuthority by random signer rejected**

## 19. Unit Scale (unitScale > 0) (5)
- [x] Init market with unitScale=1000
- [x] **Deposit 5000 lamports -> capital increases by exactly 5 units**
- [x] **Unaligned withdrawal (500 lamports) rejected**
- [x] Aligned withdrawal (1000 lamports) -> capital decreases by 1 unit
- [x] **Conservation: SPL/scale == engine.vault** (accounts for scaling)

## 20. Funding Rate — Hyperp (3)
- [x] Push mark=$150 (50% premium over index), crank 5x
- [x] **fundingRateBpsPerSlotLast non-zero OR fundingPriceSampleLast > 0** (machinery ran)
- [x] **adlCoeffLong or adlCoeffShort non-zero** (funding accrued to coefficients)
- [x] **Conservation check**

## 21. ADL + DrainOnly Mode (2)
- [x] User at max leverage, crash 95%, no insurance -> crank triggers ADL
- [x] **sideMode changed OR adlEpoch advanced OR lifetimeLiquidations > 0**
- [x] **Conservation check**

## 22. Chainlink Oracle (2)
- [x] Init market with Chainlink SOL/USD feed (99B2bTij...)
- [x] **KeeperCrank reads Chainlink price: lastOraclePrice > 0**

---

## Coverage Matrix

| Feature | Market Types Tested | Behavioral Checks | Conservation |
|---------|-------------------|-------------------|-------------|
| InitMarket | Pyth, Hyperp, Inverted, Chainlink, UnitScale | Exact state readback | Yes |
| Trading | TradeNoCpi + TradeCpi | Position mirror, fee collection | Yes |
| Liquidation | Hyperp (confirmed) | pos=0, capital=0, liqs>0, fee | Yes |
| Bank run | Pyth + Hyperp | Close count, vault arithmetic | Yes |
| Resolution | Pyth | resolved flag, force-close, drain | Yes |
| Oracle | Pyth, Chainlink, Authority push | Price readback | — |
| Funding | Hyperp | Rate or sample non-zero, coeff | Yes |
| ADL | Hyperp | Side mode or epoch change | Yes |
| unitScale | Hyperp (scale=1000) | Exact unit math, alignment | Yes |
| Inversion | Hyperp (invert=1) | Full lifecycle | Yes |
| Access control | Non-admin rejection | UpdateAdmin + SetOracleAuth | — |
| Error handling | Overleverage, over-withdraw, close-with-pos | Rejection confirmed | — |

**Total: 84 checks, 15 conservation checkpoints, 5 market configurations**
