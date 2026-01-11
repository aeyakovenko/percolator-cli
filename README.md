# percolator-cli

Command-line interface for interacting with the Percolator perpetuals protocol on Solana.

## Disclaimer

**FOR EDUCATIONAL PURPOSES ONLY**

This code has **NOT been audited**. Do NOT use in production or with real funds. The percolator program is experimental software provided for learning and testing purposes only. Use at your own risk.

## Installation

```bash
pnpm install
pnpm build
```

## Configuration

Create a config file at `~/.config/percolator-cli.json`:

```json
{
  "rpcUrl": "https://api.devnet.solana.com",
  "programId": "AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA",
  "walletPath": "~/.config/solana/id.json"
}
```

Or use command-line flags:
- `--rpc <url>` - Solana RPC endpoint
- `--program <pubkey>` - Percolator program ID
- `--wallet <path>` - Path to keypair file
- `--json` - Output in JSON format
- `--simulate` - Simulate transaction without sending

## Devnet Test Market

A live inverted SOL/USD market is available on devnet for testing. This market uses Chainlink's live SOL/USD oracle and has a funded LP with a 50bps passive matcher.

### Market Details

```
Slab:           CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm
Mint:           So11111111111111111111111111111111111111112 (Wrapped SOL)
Vault:          3ebwFoQttP7NuNDL6fvxcJd7CKChs2exosazhADp4LM8
Oracle:         99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR (Chainlink SOL/USD)
Type:           INVERTED (price = 1/SOL in USD terms)

LP (50bps Passive Matcher):
  Index:        0
  PDA:          7N9YKkZA1FzURTfEuAZDGvpPCPeSnME78MQ3kH1s5Gku
  Matcher Ctx:  Fc7SZMLEcNh24K4pjGuYsdaJkbQWB7hVrUtZbZ63yL4Q
  Collateral:   10 SOL

Insurance Fund: 100 SOL
```

### Working Features

All operations work on the test market:

1. **Initialize user account**: Create a new trading account
2. **Deposit collateral**: Add tokens to your account
3. **Withdraw collateral**: Remove tokens (if no open positions)
4. **Keeper crank**: Update funding and mark prices
5. **Trading**: Execute trades via `trade-nocpi` or `trade-cpi`

### Important: Keeper Crank Requirement

Risk-increasing trades require a **recent keeper crank**. The crank must have run within the last 200 slots (~80 seconds) for both:
- Fresh crank check: `last_crank_slot` must be recent
- Recent sweep check: `last_full_sweep_start_slot` must be recent

The sweep starts at crank step 0 of a 16-step cycle. To ensure trades work, run the keeper crank immediately before trading, or run a keeper bot that cranks frequently.

```bash
# Run keeper crank before trading
percolator-cli keeper-crank \
  --slab <slab-pubkey> \
  --oracle <oracle-pubkey>
```

### LP Detection

LP accounts are detected by checking if `matcher_program` is non-zero rather than the `kind` field. This is because LPs always have a `matcher_program` set during `init_lp`, while user accounts never do. This approach is more robust and works regardless of how the account was created.

### Testing User Operations

#### Step 1: Get devnet SOL

```bash
solana airdrop 2 --url devnet
```

#### Step 2: Wrap SOL for collateral

The market uses wrapped SOL as collateral. Wrap your devnet SOL:

```bash
# Create wrapped SOL account and wrap 1 SOL
spl-token wrap 1 --url devnet
```

#### Step 3: Initialize your user account

```bash
# Initialize user account (costs 0.001 SOL fee)
percolator-cli init-user --slab CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm
```

#### Step 4: Deposit collateral

```bash
# Deposit 0.05 SOL (50000000 lamports in 9 decimal format)
percolator-cli deposit \
  --slab CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm \
  --user-idx <your-idx> \
  --amount 50000000
```

### Check Best Prices

Before trading, you can scan available LPs to find the best prices:

```bash
percolator-cli best-price \
  --slab CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm \
  --oracle 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR
```

This shows:
- All LPs with their bid/ask quotes
- Best buy price (lowest ask)
- Best sell price (highest bid)
- Effective spread

### Trading

After depositing collateral, you can trade against the LP. Run a keeper crank first to ensure the sweep is fresh:

```bash
# Step 1: Run keeper crank (ensures sweep is fresh)
percolator-cli keeper-crank \
  --slab CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm \
  --oracle 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR

# Step 2: Trade via the 50bps matcher (long 1000 units)
percolator-cli trade-cpi \
  --slab CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm \
  --user-idx <your-idx> \
  --lp-idx 0 \
  --size 1000 \
  --matcher-program 4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy \
  --matcher-ctx Fc7SZMLEcNh24K4pjGuYsdaJkbQWB7hVrUtZbZ63yL4Q \
  --oracle 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR

# Or use trade-nocpi for direct trading without matcher
percolator-cli trade-nocpi \
  --slab CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm \
  --user-idx <your-idx> \
  --lp-idx 0 \
  --size 1000 \
  --oracle 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR
```

## Adding Your Own Matcher

Matchers are programs that determine trade pricing. The 50bps passive matcher accepts all trades at oracle price ± 50bps spread. You can create custom matchers with different pricing logic.

### Matcher Interface

A matcher program must implement:

1. **Init instruction** (discriminator: `0x01`): Initialize matcher context
2. **Match instruction** (discriminator: `0x00`): Called by percolator during `trade-cpi`

### Creating a Custom Matcher

#### Step 1: Write the matcher program

```rust
// Example: Simple spread matcher
use solana_program::{account_info::AccountInfo, entrypoint, program_error::ProgramError, pubkey::Pubkey};

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    match data[0] {
        0x00 => {
            // Match instruction - verify LP PDA and accept trade
            // LP PDA is accounts[0], context is accounts[1]
            // Return Ok(()) to accept, Err to reject
            Ok(())
        }
        0x01 => {
            // Init instruction - set up context
            // LP PDA is accounts[0], context is accounts[1]
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

#### Step 2: Deploy and create context account

```bash
# Deploy your matcher program
solana program deploy target/deploy/my_matcher.so --url devnet

# Create context account (owned by your matcher program)
# Size depends on your matcher's needs (minimum 320 bytes recommended)
```

#### Step 3: Initialize LP with your matcher

```bash
# Initialize LP with custom matcher
percolator-cli init-lp \
  --slab <slab-pubkey> \
  --matcher-program <your-matcher-program> \
  --matcher-ctx <your-context-account>
```

#### Step 4: Deposit collateral to LP

```bash
percolator-cli deposit \
  --slab <slab-pubkey> \
  --user-idx <lp-idx> \
  --amount <amount>
```

### Matcher Context Layout (50bps Passive Matcher)

The standard 50bps passive matcher uses this context layout:

```
Offset  Size  Field
0       32    LP PDA (set during init)
32      32    Slab pubkey (set during init)
64      8     Spread BPS (50 = 0.5%)
...
```

## Commands Reference

### Market Operations

```bash
# Initialize a new market
percolator-cli init-market --slab <pubkey> --mint <pubkey> --vault <pubkey> \
  --pyth-index <pubkey> --pyth-collateral <pubkey> ...

# View slab state
percolator-cli slab:get --slab <pubkey>
percolator-cli slab:header --slab <pubkey>
percolator-cli slab:config --slab <pubkey>
percolator-cli slab:nonce --slab <pubkey>
```

### User Operations

```bash
# Initialize user account
percolator-cli init-user --slab <pubkey>

# Deposit collateral
percolator-cli deposit --slab <pubkey> --user-idx <n> --amount <lamports>

# Withdraw collateral
percolator-cli withdraw --slab <pubkey> --user-idx <n> --amount <lamports>

# Trade (no CPI)
percolator-cli trade-nocpi --slab <pubkey> --user-idx <n> --lp-idx <n> \
  --size <i128> --oracle <pubkey>

# Close account
percolator-cli close-account --slab <pubkey> --idx <n>
```

### LP Operations

```bash
# Initialize LP account
percolator-cli init-lp --slab <pubkey>

# Trade with CPI (matcher)
percolator-cli trade-cpi --slab <pubkey> --user-idx <n> --lp-idx <n> \
  --size <i128> --matcher-program <pubkey> --matcher-ctx <pubkey>
```

### Keeper Operations

```bash
# Crank the keeper
percolator-cli keeper-crank --slab <pubkey> --nonce <n> --oracle <pubkey>

# Liquidate undercollateralized account
percolator-cli liquidate-at-oracle --slab <pubkey> --target-idx <n> --oracle <pubkey>
```

### Admin Operations

```bash
# Update admin
percolator-cli update-admin --slab <pubkey> --new-admin <pubkey>

# Set risk threshold
percolator-cli set-risk-threshold --slab <pubkey> --threshold-bps <n>

# Top up insurance fund
percolator-cli topup-insurance --slab <pubkey> --amount <lamports>
```

## Testing

```bash
# Run unit tests
pnpm test

# Run devnet integration tests
./test-vectors.sh

# Run live trading test (with PnL validation)
npx tsx tests/t21-live-trading.ts 3           # 3 minutes, normal market
npx tsx tests/t21-live-trading.ts 3 --inverted # 3 minutes, inverted market
```

## Scripts

```bash
# Setup a new devnet market with funded LP and insurance
npx tsx scripts/setup-devnet-market.ts

# Post fresh Pyth prices to devnet
node scripts/post-pyth-price.cjs btc
```

## Architecture

### Price Oracles

Percolator supports two oracle types:

1. **Pyth** - Uses Pyth Network price feeds via PriceUpdateV2 accounts
2. **Chainlink** - Uses Chainlink OCR2 aggregator accounts

The program auto-detects oracle type by checking the account owner.

### Inverted Markets

Inverted markets use `1/price` internally. This is useful for markets like SOL/USD where you want SOL-denominated collateral and let users take long/short USD positions. Going long = long USD (profit if SOL drops), going short = short USD (profit if SOL rises).

### Matchers

Matchers are external programs that determine trade pricing. They enable:
- Custom spread logic
- Order book matching
- AMM-style pricing
- Limit orders

## License

Apache 2.0 - see [LICENSE](LICENSE)
