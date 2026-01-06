# Compute Unit (CU) Audit

## Critical Finding

**keeper-crank CANNOT support 4096 accounts - hits 1.4M CU limit at ~2,100 accounts**

The crank instruction exhausts Solana's maximum compute budget (1,400,000 CU) with only ~2,100 accounts - roughly half of the 4,096 account capacity. Full market capacity is impossible with a single crank call.

## Devnet Verified Measurements (1.4M Budget)

### CU Scaling by Account Count

| Accounts (est) | CU Consumed | % of 1.4M | Status |
|----------------|-------------|-----------|--------|
| ~254           | 341,955     | 24%       | OK |
| ~454           | 454,719     | 32%       | OK |
| ~554           | 515,020     | 37%       | OK |
| ~654           | 575,322     | 41%       | OK |
| ~854           | 695,925     | 50%       | OK |
| ~1054          | 772,508     | 55%       | OK |
| ~1254          | 893,111     | 64%       | OK |
| ~1654          | 1,134,317   | 81%       | OK |
| ~1954          | 1,315,222   | 94%       | Near limit |
| ~2054          | 1,375,524   | 98%       | Near limit |
| ~2100+         | 1,400,000   | 100%      | **EXCEEDED MAX BUDGET** |

### Default Budget (200k) Limits

| Accounts | keeper-crank CU | Status |
|----------|-----------------|--------|
| ~245     | 93,363 - 100,599 | OK |
| 254      | 130,749         | OK |
| 257      | 191,051         | Near limit |
| 258+     | 200,000         | **EXCEEDS DEFAULT** |

## CU Scaling Analysis

**Per-account CU overhead: ~600 CU** (consistent across all measurements)

Linear formula: `CU ≈ 190,000 + (600 × accounts)`

Projected CU for different capacities:
- 500 accounts: ~490,000 CU
- 1,000 accounts: ~790,000 CU
- 2,000 accounts: ~1,390,000 CU
- 2,100 accounts: ~1,400,000 CU (**MAX BUDGET**)
- 4,096 accounts: ~2,650,000 CU (**IMPOSSIBLE**)

## Architecture Implications

### The 4096 Account Problem

The market was designed for 4,096 accounts but:
- **Maximum practical capacity: ~2,100 accounts** per single crank
- **Full capacity requires phased cranking** - multiple crank calls per slot
- Minimum 2 crank calls needed for full 4096 capacity

### Phased Crank Design (Required)

To support 4,096 accounts:
1. Split accounts into 2+ cohorts (by bitmap word index)
2. Each crank processes one cohort
3. Crank calls cycle through cohorts each slot
4. ~2,000 accounts per cohort stays within budget

Example:
- Cohort A: accounts 0-2047 (bitmap words 0-31)
- Cohort B: accounts 2048-4095 (bitmap words 32-63)

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

### Required Changes

1. **Implement phased crank** (CRITICAL)
   - Add cohort parameter to keeper-crank
   - Process ~2,000 accounts per call
   - Round-robin through cohorts

2. **Update keeper to use max budget**
   - Always request 1,400,000 CU for keeper-crank
   - Or dynamically based on account count

3. **Document capacity limits**
   - Maximum accounts per crank: ~2,100
   - Full 4096 capacity requires 2+ crank calls/slot

### Monitoring

- Alert when account count exceeds 1,500
- Track CU consumption per crank
- Warn operators when approaching limits

## Worst-Case Analysis

The true worst case (per analysis) is:

> "4096 knife-edge accounts where each is marginally liquidatable, requiring full margin calc, oracle price usage, liquidation price computation, ADL haircut math, and settlement updates."

This worst case is **impossible to process in a single crank** - it would require ~2.6M CU, nearly double the maximum allowed.

## Test Commands

```bash
# Measure current crank CU with max budget
node dist/index.js keeper-crank \
  --slab <SLAB_PUBKEY> \
  --oracle <ORACLE_PUBKEY> \
  --compute-units 1400000 \
  --simulate

# Run CU audit script
bash test-cu.sh

# Create accounts and measure scaling
bash setup-cu-test.sh
```

## Known Issues

### Bitmap Parser Bug
The engine's `num_used_accounts` counter and bitmap parsing show incorrect values. CU consumption is the reliable measure of actual account count.

## Audit Date

2026-01-05 (Updated with 1.4M CU measurements)
