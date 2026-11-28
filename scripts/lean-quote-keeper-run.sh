#!/usr/bin/env bash
# Long-running wrapper for the oracle quote keeper (scripts/_lean-quote-keeper.ts).
# Loads the Helius key into the environment WITHOUT printing it and execs the daemon (so signals reach it
# directly: SIGTERM/SIGINT = clean shutdown, lock released). NOT installed anywhere: run it under
# systemd / tmux / nohup yourself, e.g.
#   nohup scripts/lean-quote-keeper-run.sh --live >> ~/lean-quote-keeper.out 2>&1 &
# Defaults to --dry (no transactions). Extra args and env (THRESHOLD_BPS, LEAN_MANIFEST, ORACLE_KEYPAIR,
# LEAN_CLUSTER=devnet|mainnet ...) pass straight through; see the header of _lean-quote-keeper.ts.
set -euo pipefail
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd "$(dirname "$0")/.."

if [ -z "${LEAN_RPC_URL:-}" ]; then
  key_file="${HELIUS_KEY_FILE:-$HOME/.helius}"
  [ -r "$key_file" ] || { echo "cannot read $key_file (set LEAN_RPC_URL or HELIUS_KEY_FILE)" >&2; exit 1; }
  set +x
  key="$(tr -d ' \n\r' < "$key_file")"
  [ -n "$key" ] || { echo "$key_file is empty" >&2; exit 1; }
  export LEAN_RPC_URL="https://${LEAN_CLUSTER:-mainnet}.helius-rpc.com/?api-key=${key}"
  unset key
fi
echo "=== $(date -u +%FT%TZ) quote-keeper starting (args: ${*:---dry}) ==="
exec npx tsx scripts/_lean-quote-keeper.ts "$@"
