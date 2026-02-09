# Reproduce

Exact steps to create an adminless market on devnet, trade against it, and observe insurance fund growth.

## Prerequisites

```bash
solana --version    # 1.18+ or Agave 2.x+
node --version      # 20+
```

## Setup

```bash
git clone https://github.com/millw14/provenance.git
cd provenance
npm install
```

Configure a devnet wallet:

```bash
solana-keygen new --outfile ~/.config/solana/id.json   # skip if you already have one
solana config set --url devnet
solana airdrop 5
solana airdrop 5    # request twice, devnet caps at 5 per request
```

Verify balance:

```bash
solana balance
# Expected: ~10 SOL
```

## Step 1: Create market and burn admin

```bash
npx tsx scripts/init-and-burn.ts
```

Expected output:

```
=== INIT AND BURN ===

--- Phase 1: Create Market ---
Creating slab: <SLAB_PUBKEY>
Market initialized (inverted SOL/USD)
LP created at index 0
Insurance funded: 1 SOL

--- Phase 2: Burn Admin ---
Admin burned. tx: <TX_SIG>

--- Phase 3: Proof of Immutability ---
ON-CHAIN STATE:
  Admin == SystemProgram: true

DISABLED INSTRUCTIONS (no valid signer exists):
  [x] UpdateAdmin       (tag 12)
  [x] UpdateConfig      (tag 14)
  ...

VERDICT: This market has no owner.
```

Writes `devnet-market.json` with the slab address.

## Step 2: Verify immutability

```bash
SLAB=$(node -e "console.log(JSON.parse(require('fs').readFileSync('devnet-market.json','utf8')).slab)")

npx tsx src/index.ts verify-immutability --slab $SLAB --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp
```

Expected:

```
[PASS] admin_burned
[PASS] oracle_authority_disabled
[PASS] market_active
[PASS] insurance_non_withdrawable
[PASS] config_immutable
[PASS] risk_threshold_immutable
[PASS] slab_non_closeable

RESULT: Market is IMMUTABLE. No entity can modify parameters.
```

## Step 3: Trade

```bash
spl-token wrap 1 --url devnet

npx tsx src/index.ts init-user --slab $SLAB --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp

npx tsx src/index.ts deposit --slab $SLAB --user-idx 1 --amount 50000000 --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp

npx tsx src/index.ts keeper-crank --slab $SLAB --oracle 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp

npx tsx src/index.ts trade-nocpi --slab $SLAB --user-idx 1 --lp-idx 0 --size 1000 --oracle 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp
```

## Step 4: Observe insurance fund

```bash
npx tsx src/index.ts insurance:history --slab $SLAB --header --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp
```

```
slot	insurance_balance	fee_revenue	losses_absorbed	open_interest	vault
<slot>	1000001000	1000	0	1000	1051000000
```

`fee_revenue` increases with each trade. `insurance_balance` is initial topup plus fees.

## Step 5: Confirm liveness

```bash
npx tsx src/index.ts prove-liveness --slab $SLAB --rpc https://api.devnet.solana.com --program 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp
```

```
VERDICT: ALIVE
```

## Step 6: View in the observatory

```bash
cd ui && npm install && npm run dev
```

Open `http://localhost:5173/?slab=<SLAB_PUBKEY>`.

## Verify on Solscan

| What | Address | Solscan |
|------|---------|---------|
| Market (adminless slab) | `75h2kF58m3ms77c8WwzQh6h4iT2XMA1F5Mk13FZ6CCUs` | [view](https://solscan.io/account/75h2kF58m3ms77c8WwzQh6h4iT2XMA1F5Mk13FZ6CCUs?cluster=devnet) |
| Credibility Matcher (verified build, immutable) | `3Yg6brhpvLt7enU4rzvMkzexCexA1LFfAQqT3CSmGAH2` | [view](https://solscan.io/account/3Yg6brhpvLt7enU4rzvMkzexCexA1LFfAQqT3CSmGAH2?cluster=devnet) |
| percolator-prog | `2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp` | [view](https://solscan.io/account/2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp?cluster=devnet) |
| percolator-match | `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy` | [view](https://solscan.io/account/4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy?cluster=devnet) |

Reproduce the matcher build independently:

```bash
solana-verify verify-from-repo --url devnet \
  --program-id 3Yg6brhpvLt7enU4rzvMkzexCexA1LFfAQqT3CSmGAH2 \
  https://github.com/millw14/provenance \
  --mount-path matcher/credibility
# Expected: Program hash matches ✅
```

## What you just proved

1. The market was created and its admin key was burned in one sequence.
2. No instruction can modify parameters. Verifiable on-chain by reading bytes 16-48.
3. Trading generates fees that flow irreversibly into the insurance fund.
4. The insurance fund cannot be withdrawn.
5. The market operates without admin intervention.
6. The credibility matcher build is verified and its upgrade authority is permanently burned.

The insurance fund balance is the market's reputation. It grows with volume. It can never be taken out.
