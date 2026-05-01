# External Integrations

**Analysis Date:** 2026-04-30

## Summary

The CLI integrates with three primary external systems: Solana blockchain (via RPC), Pyth Network price oracles (both on-chain and off-chain via Hermes), and SPL Token program for collateral management. The integration is read-heavy for oracles and write-heavy for on-chain program interactions.

## APIs & External Services

### Solana Blockchain (Primary)

**Purpose:** All on-chain state management — market creation, trading, liquidations, account management.

**Integration points:**
- RPC Connection: `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/runtime/context.ts`
  - Creates `Connection` object from `config.rpcUrl`
  - Default endpoints: `https://api.mainnet-beta.solana.com` or `https://api.devnet.solana.com`
- Transaction building: `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/runtime/tx.ts`
  - `buildIx()` — constructs `TransactionInstruction`
  - `simulateOrSend()` — sends transactions or simulates them
  - Compute budget: configurable per-transaction (default 200,000 CU, max 1,400,000)
- Program ID: `2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp` (mainnet), configurable via `--program` flag

**Key on-chain interactions:**
| Instruction | Accounts Used | File |
|------------|---------------|------|
| InitMarket | admin, slab, mint, vault, clock, oracle | `src/abi/accounts.ts` |
| TradeNoCpi | user, lp, slab, clock, oracle | `src/commands/trade-nocpi.ts` |
| TradeCpi | user, lpOwner, slab, clock, oracle, matcherProg, matcherCtx, lpPda | `src/commands/trade-cpi.ts` |
| LiquidateAtOracle | slab, clock, oracle | `src/commands/liquidate-at-oracle.ts` |
| KeeperCrank | caller, slab, clock, oracle | `src/commands/keeper-crank.ts` |

**Auth method:** Keypair-based signing via Solana CLI JSON keypair files (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/wallet.ts`)

### Pyth Network (Price Oracle)

**Purpose:** Provides price feeds for the derivatives market. Supports two oracle types: Pyth Pull (PriceUpdateV2) and Chainlink-style aggregators.

**On-chain Oracle (Pyth PriceUpdateV2 / Chainlink Aggregator):**
- Account parsing: `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/oracle.ts`
  - `parseChainlinkPrice()` — parses Chainlink aggregator layout (offset 138: decimals, 208: timestamp, 216: price)
  - Minimum account size: 224 bytes
- Account spec: oracle is a required account in most instructions (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/abi/accounts.ts`)
- Feed ID system: Pyth Pull uses 64-char hex feed IDs (e.g., `PYTH_BTC_USD_FEED_ID` in `tests/harness.ts`)
- Index feed ID: stored in market config; all zeros = Hyperp markets (internal engine pricing)

**Off-chain Price (Hermes Client):**
- Package: `@pythnetwork/hermes-client` ^2.1.0
- Usage: `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tests/t19-pyth-live-prices.ts`
- Endpoint: `https://hermes.pyth.network` (defined in `tests/harness.ts` as `HERMES_ENDPOINT`)
- Operations:
  - `getLatestPriceUpdates([feedId], { parsed: true })` — fetch latest price
  - Price updates ~400ms frequency
- Price structure: `{ price, conf, expo, publish_time }` (parsed from Pyth PriceUpdateV2 layout)

**Pyth Solana Receiver:**
- Package: `@pythnetwork/pyth-solana-receiver` ^0.13.0
- Program ID: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (defined in `tests/harness.ts`)
- Purpose: Post Pyth pull oracle prices on-chain (not actively used in core CLI, available in tests)

**Oracle validation rules:**
- Hyperp markets: `indexFeedId === 0`, uses slab engine for pricing (no external oracle read)
- Non-Hyperp markets: require `--oracle <pubkey>` flag with the actual oracle account (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/withdraw.ts:57-68`)

### SPL Token Program

**Purpose:** Collateral token management — ATA creation, minting, transfers.

**Integration points:**
- Token program ID: `@solana/spl-token` TOKEN_PROGRAM_ID
- Well-known keys: `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/abi/accounts.ts` (`WELL_KNOWN.tokenProgram`)
- Operations:
  - `getAssociatedTokenAddress()` — derive ATA
  - `createAssociatedTokenAccountInstruction()` — create ATA
  - `createMint()` — create collateral mint (in tests)
  - `mintTo()` — fund user accounts (in tests)
- Vault: PDA derived with seeds `["vault", slab_key]` (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/pda.ts`)

### Matcher Program (External CPI)

**Purpose:** External matcher program for TradeCpi instruction — handles order matching.

**Program ID:** `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy` (50 bps passive LP matcher on devnet, defined in `tests/harness.ts`)

**Integration:**
- TradeCpi instruction passes matcher program ID and context account
- LP PDA derived for matcher: seeds `["lp", slab_key, lp_idx_u16]` (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/pda.ts`)
- Matcher context account: created and initialized per LP (`tests/harness.ts:700-747`)
- Matcher params parsed from context account (vAMM params: feeBps, spreadBps, liquidityE6) (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/best-price.ts`)

## Data Storage

**On-chain (Solana accounts):**
- **Slab account** — Main market state (1,525,624 bytes)
  - Header (136 bytes), Config (384 bytes), Engine (1,525,088 bytes), Account slots
  - Parsed via `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/slab.ts`
- **Vault ATA** — SPL token account holding collateral
- **LP PDA** — Derived PDA for matcher-delegated LPs
- **PriceUpdateV2** — Pyth pull oracle account (134+ bytes)

**Local filesystem:**
- Keypair JSON files (Solana CLI format, 64-byte array) — wallet for transaction signing
- Config file: `percolator-cli.json` (JSON, Zod-validated)
- `.env` file for test environment variables (loaded via `dotenv` in tests)

**No traditional database** — all state is on-chain.

## Authentication & Identity

**Solana Keypair Authentication:**
- Private keys stored in JSON files (Solana CLI format)
- Default path: `~/.config/solana/id.json` (configurable via `--wallet` flag or `wallet` in config)
- Loading: `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/wallet.ts` — `loadKeypair()`
- Transaction signing: all mutating instructions require payer/user keypair signatures

**No API keys or tokens** — all authentication is via Solana cryptographic signatures.

## Environment Configuration

**Required env vars (`.env` for tests):**
- `SOLANA_RPC_URL` — Solana RPC endpoint
- `WALLET_PATH` — Keypair file path

**Config file vars (`percolator-cli.json`):**
- `rpcUrl` — Solana RPC endpoint
- `programId` — Percolator program public key
- `wallet` — Path to keypair JSON
- `commitment` — Transaction commitment level (`processed` / `confirmed` / `finalized`)

**Secrets location:**
- Keypair JSON files (not in repo — listed in `.gitignore` implicitly via not committing `.env`)
- `.env.example` exists at `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/.env.example` — template only, no secrets

## Data Flow

### Trading Flow (TradeCpi)

1. CLI parses `--slab`, `--lp-idx`, `--user-idx`, `--size`, `--matcher-program`, `--matcher-context` (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/trade-cpi.ts`)
2. Context created: `Connection` + `Keypair` + `programId` (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/runtime/context.ts`)
3. Slab fetched and parsed for LP/user indices (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/slab.ts`)
4. Instruction encoded with trade parameters (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/abi/instructions.ts`)
5. Account metas built per spec (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/abi/accounts.ts`)
6. Transaction built with oracle account (Pyth/Chainlink or slab for Hyperp)
7. Transaction sent to Solana RPC via `simulateOrSend()` (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/runtime/tx.ts`)

### Oracle Price Flow

1. For Hyperp markets: engine uses internal `last_oracle_price`, no external oracle read
2. For Pyth Pull markets:
   - On-chain: `PriceUpdateV2` account data read directly by the program
   - Off-chain (Hermes): `HermesClient.getLatestPriceUpdates()` fetches fresh prices
3. For Chainlink markets: account data parsed via `parseChainlinkPrice()` (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/solana/oracle.ts`)

## Webhooks & Callbacks

**None** — this is a CLI tool with no webhook or callback infrastructure. All interactions are synchronous request-response via Solana RPC.

## CI/CD & Deployment

**Not detected** — no CI configuration files (`.github/`, `.gitlab-ci.yml`, etc.) found.

**Deployment:**
- npm package (binary CLI) published via `pnpm publish`
- Binary target: `dist/index.js` (ESM format with Node shebang)
- Platform-specific dependency: `oh-my-opencode-darwin-arm64` (macOS ARM64 only)

## Monitoring & Observability

**None integrated** — no error tracking (Sentry, etc.) or logging framework.

**Built-in output:**
- Console logging for transaction results (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/runtime/tx.ts` — `formatResult()`)
- JSON output mode available via `--json` flag (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/cli.ts`)
- Simulation mode via `--simulate` flag (dry-run without sending)

---

*Integration audit: 2026-04-30*
