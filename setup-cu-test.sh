#!/bin/bash
# Setup accounts for CU testing and measure keeper-crank CU at each tier

set -e

CLI="node dist/index.js"
SLAB="3K1P8KXJHg4Uk2upGiorjjFdSxGxq2sjxrrFaBjZ34D9"
ORACLE="HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"
FEE=1000000

# Target tiers (doubling from current ~12)
# Current: 12, targets: 24, 48, 96, 192, 384, 768, 1536, 3072
TIERS=(24 48 96 192 384 768 1536 3072)

get_account_count() {
    $CLI slab:engine --slab $SLAB 2>&1 | grep -v "bigint:" | grep "Num Used" | awk '{print $4}'
}

measure_crank_cu() {
    local count=$1
    local cu=$($CLI keeper-crank \
        --slab $SLAB \
        --funding-rate-bps-per-slot 0 \
        --oracle $ORACLE \
        --simulate 2>&1 | grep -v "bigint:" | grep "Compute Units" | awk '{print $3}' | tr -d ',')
    echo "$count,$cu"
}

create_accounts() {
    local target=$1
    local current=$(get_account_count)
    local needed=$((target - current))

    if [ $needed -le 0 ]; then
        echo "Already have $current accounts (>= $target)"
        return 0
    fi

    echo "Creating $needed accounts to reach $target..."

    for i in $(seq 1 $needed); do
        $CLI init-user --slab $SLAB --fee $FEE 2>&1 | grep -v "bigint:" > /dev/null
        if [ $((i % 10)) -eq 0 ]; then
            echo "  Created $i / $needed"
        fi
    done

    echo "Done. Now have $(get_account_count) accounts"
}

echo "=========================================="
echo "CU Scaling Test - Account Tiers"
echo "=========================================="
echo ""
echo "tier,accounts,crank_cu"

# Measure current
current=$(get_account_count)
result=$(measure_crank_cu $current)
echo "current,$result"

# For each tier, create accounts and measure
for tier in "${TIERS[@]}"; do
    create_accounts $tier
    actual=$(get_account_count)
    result=$(measure_crank_cu $actual)
    echo "tier_$tier,$result"
done

echo ""
echo "Done!"
