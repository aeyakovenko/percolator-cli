#!/bin/sh
# One-shot cron wrapper: retire the shut-down slot-3 asset on mainnet BhkMic5g once
# matured, then remove its own crontab line. Safe to run repeatedly until then.
export PATH="/home/anatoly/.nvm/versions/node/v24.10.0/bin:/usr/bin:/bin"
cd /home/anatoly/percolator-cli || exit 0
LOG=/home/anatoly/.cache/percolator/retire-slot3.log
OUT=$(node_modules/.bin/tsx scripts/retire-slot3.ts 2>&1 | grep -v 'bigint:')
echo "$OUT" >> "$LOG" 2>&1
if echo "$OUT" | grep -q RETIRE_DONE; then
  echo "$(date -u '+%Y-%m-%d %H:%M:%S') removing one-shot cron line (RETIRE_DONE)" >> "$LOG"
  crontab -l | grep -v percolator-retire-slot3-oneshot | crontab -
fi
