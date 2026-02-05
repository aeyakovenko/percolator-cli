# Percolator CLI Agent Skill Guide

This document describes how an AI agent can use the Percolator CLI and API to deploy and operate perpetual futures markets on Solana.

## Overview

Percolator is an on-chain perpetuals DEX that uses a "slab" architecture - a single account containing all market state. Markets can be configured with:
- Standard or inverted price feeds (e.g., SOL/USD vs USD/SOL)
- Admin-controlled or decentralized oracle authority
- Customizable risk parameters (margins, fees, liquidation thresholds)

## Prerequisites

```bash
# Install dependencies
npm install

# Set up Solana wallet
export SOLANA_KEYPAIR=~/.config/solana/id.json

# Configure RPC endpoint
export SOLANA_RPC_URL=https://api.devnet.solana.com
```

## Global CLI Flags

All commands support these flags:
- `--simulate` - Simulate transaction without sending
- `--json` - Output results as JSON
- `--config <path>` - Custom config file path

---

## Market Deployment Scenarios

### Scenario 1: Standard Market (No Inversion, No Admin)

Deploy a standard SOL/USD perpetual market using Pyth oracle:

```bash
# 1. Create slab account (pre-allocate space)
solana create-account slab.json 200000 2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp

# 2. Create vault token account for collateral
spl-token create-account So11111111111111111111111111111111111111112 vault.json

# 3. Initialize market
percolator init-market \
  --slab <SLAB_PUBKEY> \
  --mint So11111111111111111111111111111111111111112 \
  --vault <VAULT_PUBKEY> \
  --index-feed-id ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d \
  --max-staleness-secs 60 \
  --conf-filter-bps 100 \
  --invert 0 \
  --unit-scale 0 \
  --warmup-period 100 \
  --maintenance-margin-bps 500 \
  --initial-margin-bps 1000 \
  --trading-fee-bps 10 \
  --max-accounts 1000 \
  --new-account-fee 10000000 \
  --risk-reduction-threshold 1000000000 \
  --maintenance-fee-per-slot 1000 \
  --max-crank-staleness 100 \
  --liquidation-fee-bps 250 \
  --liquidation-fee-cap 100000000 \
  --liquidation-buffer-bps 50 \
  --min-liquidation-abs 1000000
```

### Scenario 2: Inverted Market (USD/SOL Price)

For an inverted market where price represents USD/SOL (how many SOL per USD):

```bash
percolator init-market \
  --slab <SLAB_PUBKEY> \
  --mint So11111111111111111111111111111111111111112 \
  --vault <VAULT_PUBKEY> \
  --index-feed-id ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d \
  --max-staleness-secs 60 \
  --conf-filter-bps 100 \
  --invert 1 \                    # <-- Enable inversion
  --unit-scale 1000 \             # <-- Scale for better precision
  --warmup-period 100 \
  --maintenance-margin-bps 500 \
  --initial-margin-bps 1000 \
  --trading-fee-bps 10 \
  --max-accounts 1000 \
  --new-account-fee 10000000 \
  --risk-reduction-threshold 1000000000 \
  --maintenance-fee-per-slot 1000 \
  --max-crank-staleness 100 \
  --liquidation-fee-bps 250 \
  --liquidation-fee-cap 100000000 \
  --liquidation-buffer-bps 50 \
  --min-liquidation-abs 1000000
```

### Scenario 3: Market with Admin Oracle Authority

For testing or controlled environments, set up admin-controlled price feeds:

```bash
# 1. Initialize market normally first
# 2. Set oracle authority to admin key
percolator set-oracle-authority \
  --slab <SLAB_PUBKEY> \
  --authority <ADMIN_PUBKEY>

# 3. Push prices manually
percolator push-oracle-price \
  --slab <SLAB_PUBKEY> \
  --price 150000000 \      # Price in e6 format (e.g., 150.0)
  --timestamp $(date +%s)
```

### Scenario 4: Fully Decentralized (Remove Admin)

To make a market fully decentralized after setup:

```bash
# Update admin to burn address
percolator update-admin \
  --slab <SLAB_PUBKEY> \
  --new-admin 11111111111111111111111111111111

# Remove oracle authority (require Pyth/Chainlink)
percolator set-oracle-authority \
  --slab <SLAB_PUBKEY> \
  --authority 11111111111111111111111111111111
```

### Scenario 5: Binary/Premarket (Event-Based Resolution)

Binary markets resolve to one of two outcomes (YES/NO). Unlike perpetuals, they have a finite lifecycle ending in settlement.

#### Creating a Binary Market

```bash
# 1. Create slab and vault as in Scenario 1

# 2. Initialize as Hyperp mode (admin oracle, no external feed)
percolator init-market \
  --slab <SLAB_PUBKEY> \
  --mint So11111111111111111111111111111111111111112 \
  --index-feed-id 0000000000000000000000000000000000000000000000000000000000000000 \
  --initial-mark-price 500000 \  # 50% probability (0.5 in e6)
  --max-staleness-secs 3600 \
  # ... other params

# 3. Set oracle authority (for pushing settlement price)
percolator set-oracle-authority \
  --slab <SLAB_PUBKEY> \
  --authority <ADMIN_PUBKEY>
```

#### Settlement Workflow

```typescript
// 1. Push settlement price when outcome is known
//    YES outcome = 1_000_000 (1.0 in e6)
//    NO outcome  = 1 (essentially 0)
await encodePushOraclePrice({ priceE6: "1000000", timestamp: Date.now() / 1000 });

// 2. Resolve market (blocks new activity)
await encodeResolveMarket();

// 3. Force-close all positions via KeeperCrank (paginated, 64 accounts per crank)
while (hasOpenPositions) {
  await encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
}

// 4. Withdraw insurance fund (only after all positions closed)
await encodeWithdrawInsurance();

// 5. Users withdraw remaining capital and close accounts
await encodeWithdrawCollateral({ userIdx, amount });
await encodeCloseAccount({ userIdx });

// 6. Admin closes slab
await encodeCloseSlab();
```

#### Binary Market State Flags

- **RESOLVED flag** (header offset 13, bit 0): When set:
  - `InitUser`, `InitLP`, `DepositCollateral`, `Trade*`, `TopUpInsurance` are BLOCKED
  - `WithdrawCollateral`, `CloseAccount` are ALLOWED
  - `KeeperCrank` enters force-close branch (settles positions at admin oracle price)

#### Settlement Math

```
PnL = position_size * (settlement_price - entry_price) / 1_000_000

Example (YES outcome, price=1_000_000):
  LONG 100 @ 500_000 entry → PnL = 100 * (1_000_000 - 500_000) / 1e6 = +50
  SHORT 100 @ 500_000 entry → PnL = -100 * (1_000_000 - 500_000) / 1e6 = -50
```

---

## Account Management

### Initialize LP Account

LP accounts provide liquidity and can be configured with custom matchers:

```bash
percolator init-lp \
  --slab <SLAB_PUBKEY> \
  --matcher-program <MATCHER_PROGRAM_ID> \
  --matcher-context <MATCHER_CONTEXT_PUBKEY> \
  --fee-payment 10000000
```

### Initialize User Account

```bash
percolator init-user \
  --slab <SLAB_PUBKEY> \
  --fee-payment 10000000
```

### Deposit Collateral

```bash
percolator deposit \
  --slab <SLAB_PUBKEY> \
  --user-idx 5 \
  --amount 1000000000   # 1 SOL in lamports
```

### Withdraw Collateral

```bash
percolator withdraw \
  --slab <SLAB_PUBKEY> \
  --user-idx 5 \
  --amount 500000000    # 0.5 SOL
```

### Close Account

```bash
percolator close-account \
  --slab <SLAB_PUBKEY> \
  --user-idx 5
```

---

## Trading

### Execute Trade via CPI (Recommended)

Trades through CPI require matcher program validation:

```bash
percolator trade-cpi \
  --slab <SLAB_PUBKEY> \
  --lp-idx 0 \
  --user-idx 5 \
  --size 50000000000 \           # Positive = long, negative = short
  --matcher-program <MATCHER_ID> \
  --matcher-context <MATCHER_CTX>
```

### Direct Trade (No CPI)

For LP-to-user trades without matcher:

```bash
percolator trade-nocpi \
  --slab <SLAB_PUBKEY> \
  --lp-idx 0 \
  --user-idx 5 \
  --size -25000000000    # Short position
```

---

## Market Operations

### Run Keeper Crank

Executes funding rate updates and maintenance operations:

```bash
# Permissionless crank (default)
percolator keeper-crank \
  --slab <SLAB_PUBKEY> \
  --oracle <ORACLE_PUBKEY>

# With custom compute units for complex operations
percolator keeper-crank \
  --slab <SLAB_PUBKEY> \
  --oracle <ORACLE_PUBKEY> \
  --compute-units 1400000
```

### Liquidate Undercollateralized Position

```bash
percolator liquidate-at-oracle \
  --slab <SLAB_PUBKEY> \
  --target-idx 5 \
  --oracle <ORACLE_PUBKEY>
```

### Top Up Insurance Fund

```bash
percolator topup-insurance \
  --slab <SLAB_PUBKEY> \
  --amount 10000000000  # 10 SOL
```

---

## Configuration Updates (Admin Only)

### Update Funding Rate Config

```bash
percolator update-config \
  --slab <SLAB_PUBKEY> \
  --funding-horizon-slots 100 \
  --funding-k-bps 100 \
  --funding-inv-scale-notional-e6 1000000 \
  --funding-max-premium-bps 1000 \
  --funding-max-bps-per-slot 10 \
  --thresh-floor 1000000000 \
  --thresh-risk-bps 1000 \
  --thresh-update-interval-slots 100 \
  --thresh-step-bps 100 \
  --thresh-alpha-bps 500 \
  --thresh-min 100000000 \
  --thresh-max 10000000000 \
  --thresh-min-step 10000000
```

### Set Risk Threshold

```bash
percolator set-risk-threshold \
  --slab <SLAB_PUBKEY> \
  --new-threshold 2000000000
```

### Set Maintenance Fee

```bash
percolator set-maintenance-fee \
  --slab <SLAB_PUBKEY> \
  --new-fee 2000
```

---

## State Inspection Commands

### View Market Config

```bash
percolator slab-config --slab <SLAB_PUBKEY>
```

### View Engine State

```bash
percolator slab-engine --slab <SLAB_PUBKEY>
```

### View Risk Parameters

```bash
percolator slab-params --slab <SLAB_PUBKEY>
```

### View Account State

```bash
percolator slab-account --slab <SLAB_PUBKEY> --idx 5
```

### List All Accounts

```bash
percolator slab-accounts --slab <SLAB_PUBKEY>
```

### Get Best Price

```bash
percolator best-price --slab <SLAB_PUBKEY>
```

### List All Markets

```bash
percolator list-markets
```

---

## Programmatic API Usage

### TypeScript SDK Pattern

```typescript
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "./src/solana/slab.js";
import { encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral } from "./src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL } from "./src/abi/accounts.js";
import { buildIx } from "./src/runtime/tx.js";

const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

// Read market state
async function getMarketState(conn: Connection, slab: PublicKey) {
  const data = await fetchSlab(conn, slab);
  const engine = parseEngine(data);
  const config = parseConfig(data);

  const accounts = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      accounts.push({
        idx,
        kind: acc.kind === AccountKind.LP ? "LP" : "USER",
        position: BigInt(acc.positionSize || 0),
        capital: BigInt(acc.capital || 0),
        pnl: BigInt(acc.pnl || 0),
        entryPrice: acc.entryPriceE6,
      });
    }
  }

  return { engine, config, accounts };
}

// Deposit collateral
async function deposit(conn: Connection, payer: Keypair, slab: PublicKey, userIdx: number, amount: bigint) {
  const { config } = await getMarketState(conn, slab);

  const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,           // user
    slab,                      // slab
    userAta,                   // userAta
    config.vaultPubkey,        // vault
    TOKEN_PROGRAM_ID,          // tokenProgram
    SYSVAR_CLOCK_PUBKEY,       // clock
  ]);

  const ix = buildIx({
    programId: PROGRAM_ID,
    keys,
    data: encodeDepositCollateral({ userIdx, amount: amount.toString() }),
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ix
  );

  await sendAndConfirmTransaction(conn, tx, [payer]);
}

// Execute trade
async function trade(conn: Connection, payer: Keypair, slab: PublicKey, lpIdx: number, userIdx: number, size: bigint, matcherProgram: PublicKey, matcherContext: PublicKey) {
  const { config } = await getMarketState(conn, slab);

  // Derive LP PDA
  const [lpPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slab.toBuffer(), Buffer.from([lpIdx])],
    PROGRAM_ID
  );

  const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,           // user (signer)
    lpOwnerPubkey,             // lpOwner (NOT a signer - LP delegated to matcher)
    slab,                      // slab
    SYSVAR_CLOCK_PUBKEY,       // clock
    config.indexFeedId,        // oracle
    matcherProgram,            // matcherProg
    matcherContext,            // matcherCtx
    lpPda,                     // lpPda
  ]);

  const ix = buildIx({
    programId: PROGRAM_ID,
    keys,
    data: encodeTradeCpi({ lpIdx, userIdx, size: size.toString() }),
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ix
  );

  await sendAndConfirmTransaction(conn, tx, [payer]);
}

// Run keeper crank
async function crank(conn: Connection, payer: Keypair, slab: PublicKey, oracle: PublicKey) {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    slab,
    SYSVAR_CLOCK_PUBKEY,
    oracle,
  ]);

  const ix = buildIx({
    programId: PROGRAM_ID,
    keys,
    data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ix
  );

  await sendAndConfirmTransaction(conn, tx, [payer]);
}
```

---

## Key Concepts

### PnL Calculation

- **Realized PnL**: Stored in account's `pnl` field after closing positions
- **Unrealized PnL**: `position * (current_price - entry_price) / 1e6`
- For **LONG** positions: profit when price goes UP
- For **SHORT** positions: profit when price goes DOWN

### Insurance Fund

- Surplus = `insurance_balance - threshold`
- Profit withdrawals limited to insurance surplus
- Threshold auto-adjusts based on LP risk exposure

### Price Units

- All prices stored in e6 format (multiply by 1,000,000)
- Example: $150.50 = 150500000
- Inverted markets: price represents reciprocal (USD/SOL instead of SOL/USD)

### Position Size

- Positive size = LONG position
- Negative size = SHORT position
- Size in base units (scaled by `unit_scale` if configured)

---

## Common Pyth Feed IDs

| Asset | Feed ID (Hex) |
|-------|---------------|
| SOL/USD | ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d |
| BTC/USD | e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43 |
| ETH/USD | ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace |

---

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `AccountMismatch` | Wrong account order | Check ACCOUNTS_* arrays for correct order |
| `OracleStale` | Price too old | Run keeper-crank or check oracle |
| `InsufficientMargin` | Not enough collateral | Deposit more or reduce position |
| `InsuranceInsufficient` | Insurance below threshold | Cannot withdraw profit |
| `NotAuthorized` | Wrong signer | Use correct admin/authority key |

---

## Creating Secure Matcher Contexts

### Security Requirements

When creating an LP with a custom matcher, you **MUST** use an atomic compound transaction to prevent race conditions. The matcher context must store the LP PDA for signature verification.

### Why Atomicity Matters

The matcher context stores the LP PDA that will sign trade calls. If you create the matcher context in a separate transaction from the LP, an attacker could:
1. Initialize your matcher context with their own LP PDA
2. Use your context to execute unauthorized trades

### Correct: Atomic Compound Transaction

```typescript
// All three operations in ONE atomic transaction
const atomicTx = new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),

  // 1. Create matcher context account (owned by matcher program)
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: matcherRent,
    space: MATCHER_CTX_SIZE,  // 320 bytes minimum
    programId: MATCHER_PROGRAM_ID,
  }),

  // 2. Initialize matcher context WITH LP PDA
  {
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },  // LP PDA stored for verification
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: initMatcherData,
  },

  // 3. Initialize LP in percolator (references the matcher context)
  buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData })
);

await sendAndConfirmTransaction(conn, atomicTx, [payer, matcherCtxKp]);
```

### Critical: Finding the Correct LP Index

The percolator program uses a **LIFO freelist** for slot allocation:

```rust
// Percolator's allocate_slot():
let idx = self.free_head;
self.free_head = self.next_free[idx as usize];  // LIFO pop
```

**Important:** This differs from a bitmap scan after GC operations:

| Scenario | Bitmap Scan | LIFO Freelist |
|----------|-------------|---------------|
| Fresh market (sequential alloc) | Same | Same |
| After freeing slot 1, then slot 2 | Returns 1 (lowest free) | Returns 2 (most recently freed) |

```typescript
// WRONG: May skip freed slots entirely
const lpIndex = Math.max(...usedIndices) + 1;

// WRONG after GC: Bitmap scan doesn't match LIFO order
const usedSet = new Set(parseUsedIndices(slabData));
let lpIndex = 0;
while (usedSet.has(lpIndex)) {
  lpIndex++;
}

// SAFE: For fresh markets only (no GC history), bitmap scan works.
// After GC, you must read the freelist from the slab or use retry logic.
```

### Matcher Security Checks

The matcher program must verify:

```rust
// 1. Context must be initialized before accepting trades
if !MatcherCtx::is_initialized(&data) {
    return Err(ProgramError::UninitializedAccount);
}

// 2. LP PDA must match the stored PDA (prevents unauthorized callers)
if !lp_pda.is_signer {
    return Err(ProgramError::MissingRequiredSignature);
}
let stored_pda = Pubkey::new_from_array(ctx.lp_pda);
if *lp_pda.key != stored_pda {
    return Err(ProgramError::InvalidAccountData);
}

// 3. Cannot re-initialize (prevents state manipulation)
if MatcherCtx::is_initialized(&data) {
    return Err(ProgramError::AccountAlreadyInitialized);
}
```

### Unified MatcherCtx Layout (Version 3)

```
Offset  Size  Field                    Description
0       8     magic                    0x5045_5243_4d41_5443 ("PERCMATC")
8       4     version                  3
12      1     kind                     0=Passive, 1=vAMM
13      3     _pad0
16      32    lp_pda                   LP PDA for signature verification
48      4     trading_fee_bps          Fee on fills (e.g., 5 = 0.05%)
52      4     base_spread_bps          Minimum spread (e.g., 10 = 0.10%)
56      4     max_total_bps            Cap on total cost
60      4     impact_k_bps             Impact at full liquidity
64      16    liquidity_notional_e6    Quoting depth (u128)
80      16    max_fill_abs             Max fill per trade (u128)
96      16    inventory_base           LP inventory state (i128)
112     8     last_oracle_price_e6     Last oracle price seen
120     8     last_exec_price_e6       Last execution price
128     16    max_inventory_abs        Inventory limit (u128)
144     112   _reserved
Total: 256 bytes (stored at offset 64 in 320-byte context account)
```

---

## Deployment Checklist

1. [ ] Create slab account with sufficient space (200KB recommended)
2. [ ] Create vault token account owned by vault PDA
3. [ ] Initialize market with correct parameters
4. [ ] **Use atomic transaction** for LP + matcher context creation
5. [ ] Verify LP PDA stored in matcher context matches expected
6. [ ] Fund insurance with initial capital
7. [ ] Test with small trades before production
8. [ ] Set up keeper bot for regular cranks
9. [ ] (Optional) Remove admin for decentralization
