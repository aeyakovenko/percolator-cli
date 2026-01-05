# Compute Unit (CU) Audit

## Devnet Verification (Actual CU)

Measured via `--simulate` mode against devnet slab with 12 accounts:

| Instruction | CU Consumed | Notes |
|-------------|-------------|-------|
| keeper-crank | 93,363 | Full execution with 12 accounts |
| deposit | 11,072 | Successful simulation |
| withdraw | 1,771 | Early exit (insufficient balance) |
| trade-cpi | 4,865 | Early exit (account not found) |
| liquidate-at-oracle | 1,049 | Early exit |
| close-account | 13,084 | Early exit |

## Extrapolated Worst-Case (4096 Accounts)

Based on devnet measurement of keeper-crank:
- 12 accounts: 93,363 CU
- Per-account overhead: ~7,780 CU
- Estimated 4096 accounts: ~93k + (4084 × ~200 CU/account) ≈ **~900k CU**

This exceeds the 200k default budget but is within the 1.4M max compute budget.

## Rust Native Benchmarks

From `tests/cu_benchmark.rs` with MAX_ACCOUNTS=4096:

| Operation | Native CU | BPF Estimate (~5x) |
|-----------|-----------|-------------------|
| keeper-crank (full scan) | 8,100 | ~40,000 |
| scan_and_liquidate | 10,200 | ~51,000 |
| LP risk compute | 400 | ~2,000 |

Note: Native benchmarks underestimate actual BPF CU due to additional runtime overhead.

## Recommendations

1. **keeper-crank may require increased compute budget** for markets with many accounts
2. Consider adding `ComputeBudgetInstruction::set_compute_unit_limit()` in CLI
3. Monitor CU consumption as account count grows

## How to Run

```bash
# CLI simulation tests
bash test-cu.sh

# Rust native benchmarks
cd ../percolator-prog
cargo test --release --test cu_benchmark -- --nocapture
```

## CU Checkpoints

Program-side CU checkpoints available with feature flag:

```bash
cargo build-sbf --features cu-audit
```

Checkpoints emit logs at:
- `keeper_crank_start/end`
- `trade_nocpi_compute_start/end`
- `trade_nocpi_execute_start/end`
- `trade_cpi_compute_start/end`
- `trade_cpi_execute_start/end`
- `liquidate_start/end`
- `close_account_start/end`
