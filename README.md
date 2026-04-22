# percolator-cli

Command-line interface for interacting with the Percolator perpetuals protocol on Solana.

## Related Repositories

- [percolator](https://github.com/aeyakovenko/percolator) - Risk engine library
- [percolator-prog](https://github.com/aeyakovenko/percolator-prog) - Main Percolator program (Solana smart contract)
- [percolator-match](https://github.com/aeyakovenko/percolator-match) - Passive LP matcher program (50bps spread)
- [percolator-stake](https://github.com/dcccrypto/percolator-stake) - Staking integration
- [percolator-stress-test](https://github.com/aeyakovenko/percolator-stress-test) - Stress testing suite

**Third-party repositories are community contributions. Do not trust — always verify. Review the code yourself before running or deploying anything.**

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
  "programId": "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp",
  "walletPath": "~/.config/solana/id.json"
}
```

Or use command-line flags:
- `--rpc <url>` - Solana RPC endpoint
- `--program <pubkey>` - Percolator program ID
- `--wallet <path>` - Path to keypair file
- `--json` - Output in JSON format
- `--simulate` - Simulate transaction without sending

## Mainnet (test deployment, admin-free)

```
Program:     BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw  (percolator-prog 61f3ae0 — upgrade authority BURNED)
Slab:        5ZamUkAiXtvYQijNiRcuGaea66TVbbTPusHfwMX1kTqB  (inverted SOL/USD, all 3 market auths BURNED)
Oracle:      7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE  (Pyth SOL/USD PriceUpdateV2, sponsored shard 0)
Feed ID:     ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
Vault ATA:   AcJsfpbuUKHHdoqPuLccRsK794nHecM1XKySE6Umefvr  (wrapped SOL, PDA-signed)
Matcher:     (none — third parties provision their own)
```

**Configuration:**
- Inverted (mark = SOL per USD), wSOL collateral, unit_scale=0 (1 lamport = 1 engine unit)
- Insurance fund: 5 SOL (≈ $435 at init, SOL=$87.32)
- `tvlInsuranceCapMult = 20` → max `c_tot` = 100 SOL (≈ $8,700), grows as insurance grows from new-account fees
- `maintenanceFeePerSlot = 265` lamports → ~0.0572 SOL/day/account ≈ **$5/day at SOL=$87**
- `new_account_fee = 57_000_000` lamports ≈ **$5 per `InitUser` / `InitLP`** (all routed to insurance)
- `permissionlessResolveStaleSlots = 432_000` (~48 h) + `forceCloseDelaySlots = 432_000` (~48 h) = **auto-shutdown on 48 h oracle silence**
- `maxStalenessSecs = 60` (Pyth sponsor posts every ~2 s, so this is very loose)
- 5× leverage (20% IM / 10% MM)
- No LP → no trading yet. Third-party matcher deployers create their own matcher program and call `InitLP` (anyone can — no admin gate on the LP slot).

### Hourly Crank

A permissionless keeper crank runs once per hour via cron (see `scripts/mainnet-crank.ts`). This keeps the market inside the 48 h staleness window and advances funding/accounting. Anyone can run it with their own wallet — it's a free tx signature (~5000 lamports) with no reward since it's permissionless:

```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  npx tsx scripts/mainnet-crank.ts
```

Example crontab entry (adjust paths for your system):

```cron
0 * * * * cd /path/to/percolator-cli && SOLANA_RPC_URL=https://api.mainnet-beta.solana.com /path/to/npx tsx scripts/mainnet-crank.ts >> mainnet-crank.log 2>&1
```

The script reads the manifest at `mainnet-market.json`, so dropping a copy of that file next to the script on any host is enough to run an independent keeper.

## Devnet

```
Program:        2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp (percolator-prog, v12.20 HEAD)
Matcher:        4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy (percolator-match, ABI v2)
Slab:           dtrNVk7otCtcmPvrARnLxi5nWoNFYQYS7b9vC1Yjnt2 (admin-free inverted SOL/USD, Chainlink)
Chainlink:      99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR (SOL/USD)
```

### On-chain layout (BPF)

```
SLAB_LEN        1_525_624 bytes     (~10.6 SOL rent for MAX_ACCOUNTS=4096; v12.20)
HEADER_LEN      136                 (admin + insurance_authority + insurance_operator — close_authority merged into admin)
CONFIG_LEN      400
ENGINE_OFF      536                 = align_up(136 + 400, 8)
ACCOUNT_SIZE    360                 (two-bucket warmup: sched + pending)
MAX_ACCOUNTS    4096                (configurable via `small`/`medium` cargo features)
```

The parser in `src/solana/slab.ts` derives the MAX_ACCOUNTS-dependent offsets from the slab account data length, so small, medium, and full deployments parse transparently.

### Instruction set (v12.20)

Removed: `SetRiskThreshold`, `UpdateAdmin` (tag 12), `SetMaintenanceFee`, `SetOracleAuthority` (tag 16), `SetInsuranceWithdrawPolicy`, `QueryLpFees`. All four authority roles (admin, hyperp_mark, insurance, insurance_operator) are rotated via `UpdateAuthority { kind, new_pubkey }` (tag 32). Added: `CatchupAccrue` (tag 31), `UpdateAuthority` (tag 32), `WithdrawInsuranceLimited` (tag 23, restored and gated on `insurance_operator`).

### Create a Test Market

```bash
npx tsx scripts/setup-devnet-market.ts
```

### Preflight Test (93 checks)

```bash
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY npx tsx tests/preflight.ts
```

See [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) for full coverage details (198+ automated checks).

### Keeper Crank

Risk-increasing trades require a recent keeper crank (within 200 slots).

```bash
percolator-cli keeper-crank --slab <slab-pubkey> --oracle <oracle-pubkey>
```

## Adding Your Own Matcher

Matchers are programs that determine trade pricing. The 50bps passive matcher accepts all trades at oracle price ± 50bps spread. You can create custom matchers with different pricing logic.

### Matcher Interface

A matcher program must implement:

1. **Init instruction** (tag `0x02`): Initialize context with LP PDA for security
2. **Match instruction** (tag `0x00`): Called by percolator during `trade-cpi`

### Security Requirements

**CRITICAL**: The matcher program MUST error if the LP PDA is not a signer. The percolator program signs the LP PDA via `invoke_signed` during CPI. If your matcher accepts unsigned calls, attackers can bypass LP authorization and steal funds. Always check `lp_pda.is_signer` and return `MissingRequiredSignature` if false.

The matcher context must also store the LP PDA and verify it matches on every trade call. This prevents unauthorized programs from using your matcher.

### Creating a Custom Matcher

#### Step 1: Write the matcher program

```rust
use solana_program::{account_info::AccountInfo, entrypoint, program_error::ProgramError, pubkey::Pubkey};

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    match data[0] {
        0x00 => {
            // Match instruction - MUST verify LP PDA signature
            let lp_pda = &accounts[0];
            let ctx = &accounts[1];

            // Verify LP PDA is a signer (signed by percolator via CPI)
            if !lp_pda.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }

            // Verify LP PDA matches stored PDA in context
            let ctx_data = ctx.try_borrow_data()?;
            let stored_pda = Pubkey::new_from_array(ctx_data[16..48].try_into().unwrap());
            if *lp_pda.key != stored_pda {
                return Err(ProgramError::InvalidAccountData);
            }

            // Process trade...
            Ok(())
        }
        0x02 => {
            // Init instruction - store LP PDA for verification
            let lp_pda = &accounts[0];
            let ctx = &accounts[1];

            // Store LP PDA in context at offset 16
            let mut ctx_data = ctx.try_borrow_mut_data()?;
            ctx_data[16..48].copy_from_slice(&lp_pda.key.to_bytes());
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

#### Step 2: Create LP with ATOMIC transaction

**CRITICAL**: You must create the matcher context AND initialize the LP in a single atomic transaction. This prevents race conditions where an attacker could initialize your context with their LP PDA.

```typescript
// Find the FIRST FREE slot (match percolator's bitmap scan)
const usedSet = new Set(parseUsedIndices(slabData));
let lpIndex = 0;
while (usedSet.has(lpIndex)) {
  lpIndex++;
}

// Derive LP PDA for the index we'll create
const [lpPda] = deriveLpPda(PROGRAM_ID, SLAB, lpIndex);

// ATOMIC: All three in ONE transaction
const atomicTx = new Transaction().add(
  // 1. Create matcher context account
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: rent,
    space: 320,
    programId: MATCHER_PROGRAM_ID,
  }),
  // 2. Initialize matcher context WITH LP PDA
  {
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: initMatcherData,
  },
  // 3. Initialize LP in percolator
  buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData })
);
await sendAndConfirmTransaction(conn, atomicTx, [payer, matcherCtxKp]);
```

#### Step 3: Deposit collateral to LP

```bash
percolator-cli deposit \
  --slab <slab-pubkey> \
  --user-idx <lp-idx> \
  --amount <amount>
```

### Matcher Context Layout (Unified Version 3)

The current matcher uses this unified context layout:

```
Offset  Size  Field                    Description
0       8     magic                    0x5045_5243_4d41_5443 ("PERCMATC")
8       4     version                  3
12      1     kind                     0=Passive, 1=vAMM
13      3     _pad0
16      32    lp_pda                   LP PDA for signature verification
48      4     trading_fee_bps          Fee on fills
52      4     base_spread_bps          Minimum spread
56      4     max_total_bps            Cap on total cost
60      4     impact_k_bps             Impact multiplier
64      16    liquidity_notional_e6    Quoting depth (u128)
80      16    max_fill_abs             Max fill per trade (u128)
96      16    inventory_base           LP inventory state (i128)
112     8     last_oracle_price_e6     Last oracle price
120     8     last_exec_price_e6       Last execution price
128     16    max_inventory_abs        Inventory limit (u128)
144     112   _reserved
```

The context data starts at offset 64 in the 320-byte account (first 64 bytes reserved for matcher return data).

## Commands Reference

### Market Operations

```bash
# Initialize a new market (see init-market --help for all params)
percolator-cli init-market --slab <pubkey> --mint <pubkey> --vault <pubkey> \
  --index-feed-id <hex> --max-staleness-secs <n> --conf-filter-bps <n> ...

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
# Crank the keeper (liquidations are processed automatically during crank)
percolator-cli keeper-crank --slab <pubkey> --nonce <n> --oracle <pubkey>
```

### Admin Operations

```bash
# Update admin
percolator-cli update-admin --slab <pubkey> --new-admin <pubkey>

# Top up insurance fund
percolator-cli topup-insurance --slab <pubkey> --amount <lamports>

# Update market configuration (funding and threshold params)
percolator-cli update-config --slab <pubkey> \
  --funding-horizon-slots <n> \
  --funding-k-bps <n> \
  --funding-scale-notional-e6 <n> \
  --funding-max-premium-bps <n> \
  --funding-max-bps-per-slot <n> \
  --thresh-floor <n> \
  --thresh-risk-bps <n> \
  --thresh-update-interval-slots <n> \
  --thresh-step-bps <n> \
  --thresh-alpha-bps <n> \
  --thresh-min <n> \
  --thresh-max <n> \
  --thresh-min-step <n>
```

### Oracle Authority (Admin Only)

The oracle authority feature allows the admin to push prices directly instead of relying on Chainlink. This is useful for testing scenarios like flash crashes, ADL triggers, and stress testing.

```bash
# Set oracle authority (admin only)
percolator-cli set-oracle-authority --slab <pubkey> --authority <pubkey>

# Push oracle price (authority signer required)
# Price is in USD (e.g., 143.50 for $143.50)
percolator-cli push-oracle-price --slab <pubkey> --price <usd>

# Disable oracle authority (reverts to Chainlink)
percolator-cli set-oracle-authority --slab <pubkey> --authority 11111111111111111111111111111111
```

**Security Notes:**
- Only the market admin can set the oracle authority
- Only the designated authority can push prices
- Zero price (0) is rejected to prevent division-by-zero attacks
- Setting authority to the zero address disables the feature

## Testing

```bash
# Unit tests (offline)
pnpm test

# Preflight — 93 checks across 25 sections, 3 market types
# Behavioral correctness + conservation invariants
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY npx tsx tests/preflight.ts

# Live state verification — 100 checks, exhaustive before/after state diffs
# Verifies exact field deltas on every instruction (deposit, trade, crank, etc.)
npx tsx scripts/live-verify.ts

# Integration tests (T1-T22, needs SOLANA_RPC_URL)
npx tsx tests/runner.ts
```

See [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) for full coverage details (198+ automated checks).

## Scripts

### Market Setup

```bash
# Setup a new devnet market with funded LP and insurance
npx tsx scripts/setup-devnet-market.ts
```

### Bots

```bash
# Crank bot - runs continuous keeper cranks (every 5 seconds)
npx tsx scripts/crank-bot.ts

# Random traders bot - 5 traders making random trades with momentum bias
# Routes to best LP by simulated price (vAMM vs passive)
npx tsx scripts/random-traders.ts
```

### LP Setup

```bash
# Add a vAMM-configured LP (creates matcher context + LP account + deposits collateral)
npx tsx scripts/add-vamm-lp.ts
```

### Market Analysis

```bash
# Dump full market state to state.json (positions, margins, parameters)
npx tsx scripts/dump-state.ts

# Dump comprehensive market state to market.json (all on-chain fields)
npx tsx scripts/dump-market.ts

# Check liquidation risk for all accounts
npx tsx scripts/check-liquidation.ts

# Check funding rate status and accumulation
npx tsx scripts/check-funding.ts

# Display market risk parameters
npx tsx scripts/check-params.ts
```

### User Tools

```bash
# Find user account index by owner pubkey
npx tsx scripts/find-user.ts <slab_pubkey>                    # List all accounts
npx tsx scripts/find-user.ts <slab_pubkey> <owner_pubkey>     # Find specific account
```

### Stress Testing & Security

```bash
# Haircut-ratio system stress test - conservation, insurance, undercollateralization
npx tsx scripts/stress-haircut-system.ts

# Worst-case stress test - gap risk, insurance exhaustion, socialized losses
npx tsx scripts/stress-worst-case.ts

# Oracle authority stress test - tests price manipulation scenarios
npx tsx scripts/oracle-authority-stress.ts
npx tsx scripts/oracle-authority-stress.ts 0        # Run specific scenario by index
npx tsx scripts/oracle-authority-stress.ts --disable # Disable oracle authority after tests

# Pen-test oracle - comprehensive security testing
# Tests: flash crash, price edge cases, timestamp attacks, funding manipulation
npx tsx scripts/pentest-oracle.ts

# Protocol invariant tests
npx tsx scripts/test-price-profit.ts           # Price-profit relationship validation
npx tsx scripts/test-threshold-increase.ts     # Threshold auto-adjustment verification
npx tsx scripts/test-lp-profit-realize.ts      # LP profit realization and withdrawal
npx tsx scripts/test-profit-withdrawal.ts      # Profit withdrawal limit enforcement
```

### Configuration

```bash
# Update funding configuration parameters
npx tsx scripts/update-funding-config.ts
```

## Architecture

### Price Oracles

Percolator supports multiple oracle modes:

1. **Pyth** - Uses Pyth Network price feeds via PriceUpdateV2 accounts
2. **Chainlink** - Uses Chainlink OCR2 aggregator accounts
3. **Oracle Authority** - Admin-controlled price push for testing

The program auto-detects oracle type by checking the account owner. If an oracle authority is set and has pushed a price, that price is used instead of Pyth/Chainlink.

**Oracle Authority Priority:**
1. If `oracle_authority != 0` AND `authority_price_e6 != 0` AND timestamp is recent: use authority price
2. Otherwise: fall back to Pyth/Chainlink

### Inverted Markets

Inverted markets use `1/price` internally. This is useful for markets like SOL/USD where you want SOL-denominated collateral and let users take long/short USD positions. Going long = long USD (profit if SOL drops), going short = short USD (profit if SOL rises).

### Matchers

Matchers are external programs that determine trade pricing. The `percolator-match` program supports two modes:

**Passive Mode** (mode=0): Fixed spread around oracle price
- Simple bid/ask spread (e.g., 50bps = 0.5%)
- No price impact based on trade size

**vAMM Mode** (mode=1): Spread + impact pricing
- `trading_fee_bps`: Fee charged on every fill (e.g., 5 = 0.05%)
- `base_spread_bps`: Minimum spread (e.g., 10 = 0.10%)
- `impact_k_bps`: Price impact at full liquidity utilization
- `max_total_bps`: Cap on total cost (spread + impact + fee)
- `liquidity_notional_e6`: Quoting depth for impact calculation

The random-traders bot routes to the LP with the best simulated price, computing quotes using each LP's matcher parameters.

## License

Apache 2.0 - see [LICENSE](LICENSE)
