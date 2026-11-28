#!/usr/bin/env bash
# DEVNET ONLY. Whole in-place upgrade proof in one go, on the state created by _lean-upgrade-setup.ts in $OUT_DIR:
#   probe(before) -> upgrade percolator ONLY to <candidate.so> -> verify bytes -> probe/live (after) -> insurance #117 cases
#   -> FULL UNWIND with the fixed client -> reward keeper live epoch -> final accounting.
#   OUT_DIR=<dir> lean-upgrade-run.sh <candidate percolator.so> [ins117: yes|no]
# One log per step in $OUT_DIR/run-<step>.log; a one-line summary per step on stdout. Never prints the RPC key.
set -uo pipefail
SO="$1"; INS117="${2:-no}"
export OUT_DIR="${OUT_DIR:-$(pwd)/.upgrade-out}"
RPC="https://devnet.helius-rpc.com/?api-key=$(tr -d ' \n' < "$HOME/.helius")"
PROG="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).percolator)' "$OUT_DIR/manifest.json")"
grep -q '"cluster": "devnet"' "$OUT_DIR/manifest.json" || { echo "refusing: manifest is not the devnet mirror"; exit 1; }
step() { # step <name> <cmd...>
  local name="$1"; shift
  "$@" 2>&1 | grep --line-buffered -v "npm warn" | sed -u -E 's/api-key=[^ "&]*/api-key=***/g' > "$OUT_DIR/run-$name.log"
  echo "[$name] ok=$(grep -c '^  OK ' "$OUT_DIR/run-$name.log") fail=$(grep -c '^  FAIL ' "$OUT_DIR/run-$name.log") | $(grep -E '^(PROBE|LIVE|UNWIND|INS117|ERR)|IDENTICAL|DIFFERENT|Program Id|DONE|epoch cycle' "$OUT_DIR/run-$name.log" | tail -2 | tr '\n' ' ' | cut -c1-260)"
}
T="npx -y tsx"
step probe-before $T scripts/_lean-upgrade-smoke.ts probe before
step upgrade bash scripts/lean-upgrade-deploy.sh percolator "$SO"
step verify $T scripts/_lean-upgrade-verify.ts "$PROG" "$SO"
step probe-after $T scripts/_lean-upgrade-smoke.ts probe after
step live-after-inventory $T scripts/_lean-upgrade-smoke.ts live after-inventory
if [ "$INS117" = "yes" ]; then step ins117-after $T scripts/_lean-upgrade-ins117.ts after; fi
for st in settle third takerk; do step "unwind-$st" $T scripts/_lean-upgrade-unwind.ts "$st"; done
step live-after-flat $T scripts/_lean-upgrade-smoke.ts live after-flat
for st in liq pair lp insurance deficit2; do step "unwind-$st" $T scripts/_lean-upgrade-unwind.ts "$st"; done
if [ "$INS117" = "yes" ]; then step ins117-empty $T scripts/_lean-upgrade-ins117.ts empty; fi
export SOLANA_RPC_URL="$RPC" LEAN_MANIFEST="$OUT_DIR/manifest.json" REWARD_BID_STATE_FILE="$OUT_DIR/reward-bid-state.json" MIN_NET_USD=-10 SOL_PRICE_USD=150
step reward-live timeout 400 $T scripts/_lean-r3-reward-bid.ts --live
step unwind-final $T scripts/_lean-upgrade-unwind.ts final
