#!/bin/bash
# Measure CU scaling with 1.4M compute budget
# Creates accounts in tiers and measures keeper-crank CU

set -e

CLI="node dist/index.js"
SLAB="3K1P8KXJHg4Uk2upGiorjjFdSxGxq2sjxrrFaBjZ34D9"
ORACLE="HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"
FEE=1000000
CU_LIMIT=1400000

# Tiers to test
TIERS=(256 300 350 400 500 600 700 800 1000 1200 1400 1600 2000 2500 3000 3500 4096)

get_account_count() {
    node -e "
const { Connection, PublicKey } = require('@solana/web3.js');
async function main() {
  const conn = new Connection('https://api.devnet.solana.com');
  const slabPk = new PublicKey('$SLAB');
  const info = await conn.getAccountInfo(slabPk);
  const data = info.data;
  const engineOff = 208;
  let totalBits = 0;
  for (let wordIdx = 0; wordIdx < 64; wordIdx++) {
    const off = engineOff + wordIdx * 8;
    const word = data.readBigUInt64LE(off);
    const bits = word.toString(2).split('1').length - 1;
    totalBits += bits;
  }
  console.log(totalBits);
}
main();
" 2>&1 | grep -E "^[0-9]+$"
}

measure_crank_cu() {
    local cu=$($CLI keeper-crank \
        --slab $SLAB \
        --oracle $ORACLE \
        --compute-units $CU_LIMIT \
        --simulate 2>&1 | grep -v "bigint:" | grep "Compute Units" | awk '{print $3}' | tr -d ',')
    echo "$cu"
}

create_accounts() {
    local target=$1
    local current=$(get_account_count)
    local needed=$((target - current))

    if [ $needed -le 0 ]; then
        echo "Already have $current accounts (>= $target)" >&2
        return 0
    fi

    echo "Creating $needed accounts to reach $target..." >&2

    for i in $(seq 1 $needed); do
        $CLI init-user --slab $SLAB --fee $FEE 2>&1 | grep -v "bigint:" > /dev/null
        if [ $((i % 50)) -eq 0 ]; then
            echo "  Created $i / $needed" >&2
        fi
    done

    echo "Done. Now have $(get_account_count) accounts" >&2
}

echo "==========================================="
echo "CU SCALING TEST (1.4M CU Budget)"
echo "==========================================="
echo ""
echo "accounts,cu_consumed,percent_of_max"

# Measure current
current=$(get_account_count)
cu=$(measure_crank_cu)
pct=$((cu * 100 / CU_LIMIT))
echo "$current,$cu,$pct%"

# For each tier
for tier in "${TIERS[@]}"; do
    create_accounts $tier
    sleep 2  # Wait for devnet to settle
    actual=$(get_account_count)
    cu=$(measure_crank_cu)

    if [ -z "$cu" ]; then
        echo "$actual,ERROR,N/A"
        continue
    fi

    pct=$((cu * 100 / CU_LIMIT))
    echo "$actual,$cu,$pct%"

    # Stop if we hit 95% of budget
    if [ $cu -gt 1330000 ]; then
        echo ""
        echo "WARNING: Approaching 1.4M CU limit. Stopping." >&2
        break
    fi
done

echo ""
echo "Done!"
