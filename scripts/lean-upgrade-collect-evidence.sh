#!/usr/bin/env bash
# Copy the (already key-masked) logs + manifests of an upgrade-proof run into a tracked evidence directory as .txt
# (*.log is git-ignored). NEVER copies keypairs; refuses if anything that looks like an RPC key or a secret key slipped in.
#   lean-upgrade-collect-evidence.sh <OUT_DIR> <dest dir>
set -eu
SRC="$1"; DST="$2"
mkdir -p "$DST"
for f in "$SRC"/*.log "$SRC"/*.summary; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  sed -E 's/api-key=[^ "&]*/api-key=***/g' "$f" | grep -v -E '^([a-z]+ ){11}[a-z]+$' | cut -c1-600 > "$DST/${b%.*}.txt"
done
cp "$SRC/manifest.json" "$DST/manifest.json"
for f in "$SRC"/probe-*.json; do [ -e "$f" ] && cp "$f" "$DST/"; done
if grep -rIl -E 'api-key=[0-9a-f]{8}|\[[0-9]{1,3}(,[0-9]{1,3}){63}\]' "$DST" >/dev/null 2>&1; then echo "REFUSING: secret-looking content in $DST"; exit 1; fi
echo "evidence -> $DST ($(ls "$DST" | wc -l) files)"
