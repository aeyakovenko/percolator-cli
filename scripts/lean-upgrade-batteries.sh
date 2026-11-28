#!/usr/bin/env bash
# DEVNET ONLY. Run the existing batteries against the FRESH upgrade-proof program ids (never the shared LEAN_DEVNET ones).
#   lean-upgrade-batteries.sh <tag>      -> logs in $OUT_DIR/battery-<tag>-<name>.log, one summary line per battery
set -uo pipefail
TAG="${1:-run}"
OUT_DIR="${OUT_DIR:-$(pwd)/.upgrade-out}"
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=$(tr -d ' \n' < "$HOME/.helius")"
pub() { node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))).publicKey.toBase58())' "$OUT_DIR/$1-keypair.json"; }
export LEAN_PROG="$(pub percolator)" LEAN_MATCHER="$(pub matcher)" LEAN_ORACLE_ADAPTER="$(pub oracle_adapter)" LEAN_REWARD_MODULE="$(pub reward_module)"
case "$LEAN_PROG" in 4xw3wdbq*|EUj4Jj8S*) echo "refusing: shared/live program id"; exit 1;; esac
echo "batteries [$TAG] on percolator $LEAN_PROG matcher $LEAN_MATCHER"
for f in lean-attack _lean-xmargin-drain _lean-exploit _lean-builtin-funding _lean-propamm-devnet; do
  log="$OUT_DIR/battery-$TAG-$f.log"
  timeout 1500 npx -y tsx "scripts/$f.ts" 2>&1 | grep --line-buffered -v "npm warn" | sed -u -E 's/api-key=[^ "&]*/api-key=***/g' > "$log"
  rc=${PIPESTATUS[0]}
  echo "[$TAG] $f: exit $rc | $(grep -E "passed|failed|CLEAN|PASS|FAIL|ok,|✗" "$log" | tail -3 | tr '\n' ' ' | cut -c1-400)"
done
