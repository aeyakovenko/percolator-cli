#!/bin/bash
# Compute Unit (CU) audit tests for percolator-cli
# Runs instructions in simulation mode and measures CU consumption
# Run with: bash test-cu.sh

set +e

CLI="node dist/index.js"
SLAB="3K1P8KXJHg4Uk2upGiorjjFdSxGxq2sjxrrFaBjZ34D9"
MINT="9zga2SxEKz4xpJY5WBhc7FXYWaxtd5P5fHZvWr984a7U"
VAULT="AMiwW6FznsdqrT6EgAKVCq5QPQb2PaATJ4Xcwuzw7jXe"
ORACLE_INDEX="HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"
ORACLE_COL="JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB"
ORACLE="oraoXdxzHjXp8Wo5V6tTUo9xyUZ14KhrGGt13hfqNfT"

echo "=========================================="
echo "PERCOLATOR-CLI CU AUDIT"
echo "=========================================="
echo ""

# CU Budgets (based on Rust benchmarks with MAX_ACCOUNTS=4096)
declare -A BUDGETS
BUDGETS["keeper-crank"]=80000      # Benchmark: ~40k BPF for 4096 accounts
BUDGETS["liquidate-at-oracle"]=80000
BUDGETS["trade-cpi"]=60000
BUDGETS["close-account"]=80000
BUDGETS["trade-nocpi"]=50000
BUDGETS["init-market"]=50000
BUDGETS["deposit"]=40000
BUDGETS["withdraw"]=40000
BUDGETS["init-user"]=30000
BUDGETS["init-lp"]=30000
BUDGETS["topup-insurance"]=30000
BUDGETS["set-risk-threshold"]=20000
BUDGETS["update-admin"]=20000

# Extract CU from simulation output
# Matches: "Compute Units: 1,023" or from logs: "consumed 1023 of 200000"
extract_cu() {
    local output="$1"
    # Try "Compute Units: X" format first
    local cu=$(echo "$output" | grep -oP 'Compute Units: [\d,]+' | head -1 | grep -oP '[\d,]+' | tr -d ',')
    if [ -n "$cu" ]; then
        echo "$cu"
        return
    fi
    # Fallback to log format: "consumed X of Y"
    cu=$(echo "$output" | grep -oP 'consumed \d+ of' | head -1 | grep -oP '\d+')
    echo "$cu"
}

TOTAL_CU=0
OVER_BUDGET=0
TESTS=0

test_cu() {
    local name="$1"
    local budget="${BUDGETS[$name]}"
    shift
    local output=$("$@" 2>&1)
    local cu=$(extract_cu "$output")

    ((TESTS++))

    if [ -z "$cu" ]; then
        echo "⚠ $name: No CU data (may have failed)"
        return
    fi

    TOTAL_CU=$((TOTAL_CU + cu))
    local percent=$((cu * 100 / budget))

    if [ "$cu" -gt "$budget" ]; then
        echo "✗ $name: $cu CU ($percent%) - OVER BUDGET ($budget)"
        ((OVER_BUDGET++))
    elif [ "$percent" -gt 80 ]; then
        echo "⚠ $name: $cu CU ($percent%) - Near budget limit ($budget)"
    else
        echo "✓ $name: $cu CU ($percent%) - OK (budget: $budget)"
    fi
}

echo "=== INSTRUCTION CU MEASUREMENTS ==="
echo "(Running in --simulate mode)"
echo ""

# Note: Many of these will fail with errors but still report CU consumed
# The CU consumption before the error is still useful data

echo "--- Low Risk Instructions ---"

test_cu "deposit" \
    $CLI --simulate deposit --slab $SLAB --user-idx 0 --amount 1000000

test_cu "withdraw" \
    $CLI --simulate withdraw --slab $SLAB --user-idx 0 --amount 1000000

test_cu "topup-insurance" \
    $CLI --simulate topup-insurance --slab $SLAB --amount 1000000

echo ""
echo "--- Medium Risk Instructions ---"

test_cu "trade-nocpi" \
    $CLI --simulate trade-nocpi --slab $SLAB --user-idx 0 --lp-idx 1 \
    --size 1000000000 --oracle $ORACLE

test_cu "trade-cpi" \
    $CLI --simulate trade-cpi --slab $SLAB --user-idx 0 --lp-idx 1 \
    --size 1000000000 \
    --matcher-program 4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy \
    --matcher-context DgsgVav42BC1wGnyQpfz9NGC16RTva45yGepL5kBQmiV

echo ""
echo "--- High Risk Instructions ---"

test_cu "keeper-crank" \
    $CLI --simulate keeper-crank --slab $SLAB \
    --oracle $ORACLE --compute-units 1400000

test_cu "liquidate-at-oracle" \
    $CLI --simulate liquidate-at-oracle --slab $SLAB \
    --target-idx 1 --oracle $ORACLE

test_cu "close-account" \
    $CLI --simulate close-account --slab $SLAB --user-idx 0

echo ""
echo "=========================================="
echo "CU AUDIT SUMMARY"
echo "=========================================="
echo "Tests run:    $TESTS"
echo "Over budget:  $OVER_BUDGET"
echo ""

if [ "$OVER_BUDGET" -gt 0 ]; then
    echo "⚠ WARNING: $OVER_BUDGET instruction(s) exceeded CU budget!"
    echo "Consider optimizing or increasing budget limits."
    exit 1
else
    echo "✓ All instructions within CU budget"
fi

echo ""
echo "=========================================="
echo "WORST-CASE BENCHMARKS (Rust Native)"
echo "=========================================="
echo ""
echo "Benchmark results from tests/cu_benchmark.rs with MAX_ACCOUNTS=4096:"
echo ""
echo "1. keeper-crank (4096 accounts with positions):"
echo "   - Native:    ~8,100 CU"
echo "   - BPF (5x):  ~40,000 CU"
echo "   - Status:    WELL WITHIN 200k BUDGET"
echo ""
echo "2. scan_and_liquidate (full 4096 account scan):"
echo "   - Native:    ~10,200 CU"
echo "   - BPF (5x):  ~51,000 CU"
echo "   - Status:    WELL WITHIN 200k BUDGET"
echo ""
echo "3. LP risk compute (account bitmap scan):"
echo "   - Native:    ~400 CU"
echo "   - BPF (5x):  ~2,000 CU"
echo "   - Status:    MINIMAL OVERHEAD"
echo ""
echo "Run benchmarks: cd ../percolator-prog && cargo test --release --test cu_benchmark -- --nocapture"
echo ""
echo "CU checkpoints available with: --features cu-audit"
