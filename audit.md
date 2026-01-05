# Compute Unit (CU) Audit

## CLI Simulation Results

Measured via `--simulate` mode against devnet (early-exit CU before full execution):

| Instruction | CU Consumed | Budget | Usage |
|-------------|-------------|--------|-------|
| deposit | 18,181 | 40,000 | 45% |
| withdraw | 21,051 | 40,000 | 52% |
| topup-insurance | 17,905 | 30,000 | 59% |
| trade-nocpi | 1,138 | 50,000 | 2% |
| trade-cpi | 6,365 | 60,000 | 10% |
| keeper-crank | 1,153 | 80,000 | 1% |
| liquidate-at-oracle | 1,049 | 80,000 | 1% |
| close-account | 13,084 | 80,000 | 16% |

## Worst-Case Benchmarks (4096 Accounts)

Measured via Rust native benchmarks (`tests/cu_benchmark.rs`):

| Operation | Native CU | BPF Estimate (~5x) | Status |
|-----------|-----------|-------------------|--------|
| keeper-crank (full scan) | 8,100 | ~40,000 | OK |
| scan_and_liquidate | 10,200 | ~51,000 | OK |
| LP risk compute | 400 | ~2,000 | OK |

## Summary

All instructions are **well within the 200,000 CU default budget**, even with worst-case scenarios of 4096 accounts fully populated with positions.

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
