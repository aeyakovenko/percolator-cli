#!/usr/bin/env bash
# DEVNET ONLY. Two-hop in-place upgrade proof (what mainnet does): fresh percolator id on 887ba02 -> mirror the state
# -> upgrade to <hop1.so> -> live activity + insurance receipts created UNDER hop1 -> then lean-upgrade-run.sh <hop2.so>.
#   OUT_DIR=<dir with fresh keypairs> lean-upgrade-twohop.sh <887ba02.so> <hop1.so> <hop2.so>
set -uo pipefail
BASE="$1"; HOP1="$2"; HOP2="$3"
export OUT_DIR="${OUT_DIR:?set OUT_DIR}"
T="npx -y tsx"
filt() { grep --line-buffered -v "npm warn" | sed -u -E 's/api-key=[^ "&]*/api-key=***/g'; }
bash scripts/lean-upgrade-deploy.sh percolator "$BASE" 160000 2>&1 | grep -E "^deploy|Program Id"
$T scripts/_lean-upgrade-setup.ts 2>&1 | filt > "$OUT_DIR/run-setup.log"; tail -1 "$OUT_DIR/run-setup.log"
$T scripts/_lean-upgrade-ins117.ts pre 2>&1 | filt > "$OUT_DIR/run-ins117-pre.log"; tail -1 "$OUT_DIR/run-ins117-pre.log"
PROG="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).percolator)' "$OUT_DIR/manifest.json")"
bash scripts/lean-upgrade-deploy.sh percolator "$HOP1" 2>&1 | grep -E "^deploy|Program Id"
$T scripts/_lean-upgrade-verify.ts "$PROG" "$HOP1" 2>&1 | filt
# activity under hop1: taker fills (legs re-stamped by hop1), keeper push, a NEW insurance receipt deposited under hop1
$T scripts/_lean-upgrade-smoke.ts live hop1 2>&1 | filt > "$OUT_DIR/run-live-hop1.log"; tail -1 "$OUT_DIR/run-live-hop1.log"
bash scripts/lean-upgrade-run.sh "$HOP2" yes
