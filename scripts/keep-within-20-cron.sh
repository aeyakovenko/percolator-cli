#!/bin/sh
# Continuous cranker: keep m0 & m2 within max_accrual_dt (20 slots) of the clock.
# Zero priority fee (base fee only). Runs ~56s per minute (cron) on the keeper key.
# m1 (STOXX) is deferred until an admin ConfigureHybridOracle re-anchor during EU hours.
export PATH="/home/anatoly/.nvm/versions/node/v24.10.0/bin:/usr/bin:/bin"
cd /home/anatoly/percolator-cli || exit 0
KEEPER_KEYPAIR="$HOME/.config/solana/bounty5-keeper.json" RUN_MS=56000 CADENCE_MS=7000 \
  node_modules/.bin/tsx scripts/keep-within-20.ts >> "$HOME/.cache/percolator/keep-within-20.log" 2>&1
