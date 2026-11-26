#!/usr/bin/env bash
# Keep the live percolator-lean bounty market oracle fresh: crank it from Pyth.
# Every 30 min = ~2x the ~60-min (9000-slot) staleness window: 1 crank needed per
# window + 1 safety if a run fails. As slow as possible while never going stale.
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd /home/ubuntu/percolator-cli || exit 1
echo "=== $(date -u +%FT%TZ) crank ==="
npx tsx scripts/_lean-crank.ts 1 2>&1
