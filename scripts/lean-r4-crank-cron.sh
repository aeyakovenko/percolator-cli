#!/usr/bin/env bash
# Lazy BTC keeper for the mainnet ROUND-4 bounty (9b45ad1). Pushes Coinbase BTC only when the oracle is past
# 1/3 of its ~60-min window. Each push also accrues the market's built-in funding. Minimal SOL. Cron every 15 min.
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd /home/ubuntu/percolator-cli || exit 1
echo "=== $(date -u +%FT%TZ) r4-crank ==="
npx tsx scripts/_lean-r4-crank.ts lazy 2>&1
