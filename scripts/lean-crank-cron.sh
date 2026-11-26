#!/usr/bin/env bash
# Keep the live percolator-lean bounty market oracle fresh: crank it from Pyth.
# Runs every 10 min, LAZY: only sends a crank tx once the oracle passes 1/3 of its
# ~60-min (9000-slot) staleness window. Worst-case crank gap <= maxStaleness/2, so
# every staleness window gets >= 2 cranks (one is a safety backup).
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd /home/ubuntu/percolator-cli || exit 1
echo "=== $(date -u +%FT%TZ) crank ==="
npx tsx scripts/_lean-crank.ts lazy 2 2>&1
