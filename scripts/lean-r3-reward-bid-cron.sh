#!/usr/bin/env bash
# Lazy EV+ bidder for the mainnet round-3.1 wSOL buy-and-burn reward auction.
# Self-gates: runs a full epoch (StartEpoch->SubmitBid->SettleEpoch->ClaimQuote) ONLY when the pot
# is >= minBatch AND the sole-bidder optimal wSOL bid nets positive (claimed USDC > burned wSOL + rent).
# Otherwise it just reads state and exits (no spend). Cron every 6h.
export PATH="/home/ubuntu/.nvm/versions/node/v22.18.0/bin:$PATH"
cd /home/ubuntu/percolator-cli || exit 1
KEY=$(tr -d ' \n' < "$HOME/.helius")
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=${KEY}"
echo "=== $(date -u +%FT%TZ) r3-reward-bid ==="
npx tsx scripts/_lean-r3-reward-bid.ts --live 2>&1
