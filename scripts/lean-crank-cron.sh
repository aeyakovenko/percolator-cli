 Runs every 15 min but LAZY.*#!/usr/bin/env bash
 Runs every 15 min but LAZY.*# Keep the live percolator-lean bounty market oracle fresh: crank it from Pyth.
 Runs every 15 min but LAZY.*# Runs every 15 min but LAZY: only sends a crank tx when the market oracle is past
 Runs every 15 min but LAZY.*# 75% of its ~60-min (9000-slot) staleness window. Minimal txs, never goes stale.
 Runs every 15 min but LAZY.*export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
 Runs every 15 min but LAZY.*cd /home/ubuntu/percolator-cli || exit 1
 Runs every 15 min but LAZY.*echo "=== $(date -u +%FT%TZ) crank ==="
 Runs every 15 min but LAZY.*npx tsx scripts/_lean-crank.ts lazy 2 2>&1
