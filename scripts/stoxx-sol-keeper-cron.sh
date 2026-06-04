#!/bin/sh
# STOXX/SOL keeper cron wrapper: minute-cadence, dormant-when-empty.
# Replaces both keep-within-20-cron.sh and the per-minute proximity ticker.
export PATH="/home/anatoly/.nvm/versions/node/v24.10.0/bin:/usr/bin:/bin"
cd /home/anatoly/percolator-cli || exit 0
mkdir -p "$HOME/.cache/percolator"
KEEPER_KEYPAIR="$HOME/.config/solana/bounty5-keeper.json" \
  node_modules/.bin/tsx scripts/mainnet-stoxx-sol-keeper.ts \
  >> "$HOME/.cache/percolator/stoxx-sol-keeper.log" 2>&1
