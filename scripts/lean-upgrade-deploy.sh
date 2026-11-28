#!/usr/bin/env bash
# DEVNET ONLY. Deploy / upgrade one program of the in-place upgrade proof with the Agave 4.4.1 CLI.
#   lean-upgrade-deploy.sh <name: percolator|matcher|oracle_adapter|reward_module> <path-to.so> [max-len]
# Program keypair = $OUT_DIR/<name>-keypair.json (re-running with the same keypair UPGRADES in place).
# The Helius key is never printed (api-key=... is masked in all output).
set -euo pipefail
NAME="$1"; SO="$2"; MAXLEN="${3:-}"
OUT_DIR="${OUT_DIR:-$(pwd)/.upgrade-out}"
RPC="https://devnet.helius-rpc.com/?api-key=$(tr -d ' \n' < "$HOME/.helius")"
SOLANA="$HOME/.local/agave-latest/bin/solana"
ARGS=(program deploy "$SO" --program-id "$OUT_DIR/$NAME-keypair.json" -u "$RPC" -k "$HOME/.config/solana/id.json" --upgrade-authority "$HOME/.config/solana/id.json")
if [ -n "$MAXLEN" ]; then ARGS+=(--max-len "$MAXLEN"); fi
echo "deploy $NAME <- $SO (sha256 $(sha256sum "$SO" | cut -c1-16)…, $(stat -c %s "$SO") B)"
"$SOLANA" "${ARGS[@]}" 2>&1 | sed -E 's/api-key=[^ "&]*/api-key=***/g'
