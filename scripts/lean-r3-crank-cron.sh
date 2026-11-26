#!/usr/bin/env bash
# Lazy BTC keeper for the mainnet round-3 bounty: pushes Coinbase BTC only when the oracle is past
# 1/3 of its ~60-min window. Minimal SOL. Cron every 15 min -> ~2-3 tiny txs/hour, never goes stale.
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd /home/ubuntu/percolator-cli || exit 1
echo "=== $(date -u +%FT%TZ) r3-crank ==="
npx tsx scripts/_lean-r3-crank.ts lazy 2>&1
