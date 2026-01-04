# percolator-cli

Command-line interface for interacting with the Percolator perpetuals protocol on Solana.

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

## Commands

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
```

## License

Apache 2.0 - see [LICENSE](LICENSE)
