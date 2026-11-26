#!/usr/bin/env bash
# Keep the live percolator-lean bounty market oracle fresh: crank it from Pyth.
# Runs every 15 min but LAZY: only sends a crank tx when the market oracle is past
# 75% of its ~60-min (9000-slot) staleness window. Minimal txs, never goes stale.
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd /home/ubuntu/percolator-cli || exit 1
echo "=== $(date -u +%FT%TZ) crank ==="
npx tsx scripts/_lean-crank.ts lazy 2 2>&1
