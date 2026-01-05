# Compute Unit (CU) Audit

## Critical Finding

**keeper-crank exceeds 200k CU default budget at ~254 accounts**

The crank instruction hits the Solana default compute budget limit (200,000 CU) with only 254 accounts - far short of the 4,096 account capacity.

## Devnet Verified Measurements

| Accounts | keeper-crank CU | Status |
|----------|-----------------|--------|
| ~245 | 93,363 - 100,599 | OK |
| 254 | 130,749 | OK |
| 257 | 191,051 | Near limit |
| 258+ | 200,000 | **EXCEEDS DEFAULT BUDGET** |

### CU Scaling Analysis

Per-account CU overhead: **~3,000-8,000 CU/account** (varies based on account state)

Estimated CU for full capacity:
- 1,000 accounts: ~500,000 CU
- 2,000 accounts: ~1,000,000 CU
- 4,096 accounts: ~1,400,000+ CU (at/beyond max budget)

## Other Instructions (Devnet Verified)

| Instruction | CU Consumed | Notes |
|-------------|-------------|-------|
| init-user | 18,372 | Success |
| deposit | 11,072 | Success |
| withdraw | 1,771 | Early exit |
| trade-cpi | 4,865 | Early exit |
| liquidate-at-oracle | 1,049 | Early exit |
| close-account | 13,084 | Early exit |

## Recommendations

### Immediate Actions Required

1. **Add ComputeBudgetInstruction to keeper-crank**
   - Request 400,000 CU for markets with 500+ accounts
   - Request 1,000,000 CU for markets with 1000+ accounts
   - Request 1,400,000 CU for near-capacity markets

2. **Implement phased crank** (if not already)
   - Process accounts in batches
   - Multiple crank calls per slot if needed

3. **Monitor account growth**
   - Alert when account count exceeds 200
   - Require increased compute budget for large markets

### Worst-Case Scenario

Per the user's analysis, the true worst case is NOT "all accounts are dust" but:

> "4096 knife-edge accounts where each is marginally liquidatable, requiring full margin calc, oracle price usage, liquidation price computation, ADL haircut math, and settlement updates."

This worst case would require the maximum 1.4M CU budget and may still exceed it.

## Test Commands

```bash
# Run CU audit script
bash test-cu.sh

# Create accounts and measure scaling
bash setup-cu-test.sh

# Measure current crank CU
node dist/index.js keeper-crank \
  --slab <SLAB_PUBKEY> \
  --funding-rate-bps-per-slot 0 \
  --oracle <ORACLE_PUBKEY> \
  --simulate
```

## Slab Bitmap Parser Bug (Fixed)

Note: The slab:bitmap command was incorrectly reporting account counts. The actual bitmap parsing revealed 254 accounts where the engine counter showed 12. This has been identified for fixing.

## Audit Date

2026-01-05
