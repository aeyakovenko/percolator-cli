#!/usr/bin/env bash
# DEVNET ONLY. Clean 887ba02 BASELINE of the smoke (no upgrade): fresh percolator id -> mirror state -> probe + live.
#   OUT_DIR=<dir with fresh keypairs> lean-upgrade-baseline.sh <887ba02 percolator.so>
set -uo pipefail
export OUT_DIR="${OUT_DIR:?set OUT_DIR}"
T="npx -y tsx"
filt() { grep --line-buffered -v "npm warn" | sed -u -E 's/api-key=[^ "&]*/api-key=***/g'; }
bash scripts/lean-upgrade-deploy.sh percolator "$1" 160000 2>&1 | grep -E "^deploy|Program Id"
$T scripts/_lean-upgrade-setup.ts 2>&1 | filt > "$OUT_DIR/run-setup.log"; tail -1 "$OUT_DIR/run-setup.log"
$T scripts/_lean-upgrade-smoke.ts probe before 2>&1 | filt > "$OUT_DIR/run-probe-before.log"; tail -1 "$OUT_DIR/run-probe-before.log"
$T scripts/_lean-upgrade-smoke.ts live before 2>&1 | filt > "$OUT_DIR/run-live-before.log"; tail -1 "$OUT_DIR/run-live-before.log"
