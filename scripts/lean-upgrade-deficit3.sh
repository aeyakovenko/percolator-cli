#!/usr/bin/env bash
# DEVNET ONLY. On an existing 887ba02 baseline mirror ($OUT_DIR): two-hop upgrade, then the sacrificial-market
# liquidation stage and the NON-COOPERATIVE-holder deficit scenario (wind-down -> ForceClosePair -> drain).
#   OUT_DIR=<dir> lean-upgrade-deficit3.sh <hop1.so> <hop2.so>
set -uo pipefail
export OUT_DIR="${OUT_DIR:?set OUT_DIR}"
T="npx -y tsx"
filt() { grep --line-buffered -v "npm warn" | sed -u -E 's/api-key=[^ "&]*/api-key=***/g'; }
PROG="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).percolator)' "$OUT_DIR/manifest.json")"
for so in "$1" "$2"; do
  bash scripts/lean-upgrade-deploy.sh percolator "$so" 2>&1 | grep -E "^deploy|Program Id"
  $T scripts/_lean-upgrade-verify.ts "$PROG" "$so" 2>&1 | filt
done
for st in liq deficit3; do
  $T scripts/_lean-upgrade-unwind.ts "$st" 2>&1 | filt > "$OUT_DIR/run-unwind-$st.log"; tail -1 "$OUT_DIR/run-unwind-$st.log"
done
