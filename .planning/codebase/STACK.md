# Technology Stack

**Analysis Date:** 2026-04-30

## Summary

This is a TypeScript CLI application for interacting with the Percolator decentralized derivatives protocol on Solana. It uses Node.js with ESM modules, bundled via tsup, and integrates with Solana blockchain, Pyth Network price oracles, and SPL Token program.

## Runtime

**Environment:**
- Node.js >= 20 (`package.json` engines field)
- Module system: ESM (`"type": "module"` in `package.json`)

**Package Manager:**
- pnpm (detected via `pnpm-lock.yaml` and `.npmrc` with `shamefully-hoist=true`)
- Lockfile: `pnpm-lock.yaml` present

## Languages

**Primary:**
- TypeScript 5.7.2 (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/package.json`)
  - Used for all source code in `src/` and test files in `tests/`
  - Target: ES2022 (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tsconfig.json`)
  - Module resolution: bundler (`tsconfig.json`)

## Frameworks & Libraries

**CLI Framework:**
- `commander` ^12.1.0 — CLI argument parsing and command registration (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/cli.ts`)

**Solana Ecosystem:**
- `@solana/web3.js` ^1.95.4 — Solana blockchain interaction (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/runtime/context.ts`, `src/solana/*.ts`)
- `@solana/spl-token` ^0.3.11 — SPL Token operations (ATA creation, minting, transfers) (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/abi/accounts.ts`)

**Oracle / Price Feeds:**
- `@pythnetwork/hermes-client` ^2.1.0 — Off-chain Pyth price feed client (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tests/t19-pyth-live-prices.ts`)
- `@pythnetwork/pyth-solana-receiver` ^0.13.0 — On-chain Pyth price posting (listed in `package.json` dependencies, used in test harness)

**Validation:**
- `zod` ^3.23.8 — Runtime configuration validation (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/config.ts`)

**Utilities:**
- `oh-my-opencode-darwin-arm64` ^3.17.6 — Bundled binary dependency (macOS ARM64 only) (`package.json` dependencies)

## Build Tools

**Bundler:**
- `tsup` ^8.3.5 — TypeScript bundler for ESM output (`/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tsup.config.ts`)
  - Entry: `src/index.ts`
  - Output: `dist/` directory
  - Format: ESM with Node.js shebang banner
  - Target: node20
  - Sourcemaps: enabled

**TypeScript Compiler:**
- `typescript` ^5.7.2 — TypeScript type checking and transpilation
- `tsx` ^4.21.0 — TypeScript execution for tests (`package.json` scripts)

**Type Definitions:**
- `@types/node` ^20.17.10 — Node.js type definitions

## Scripts

```bash
pnpm build              # tsup (build the CLI)
pnpm dev                # pnpm build && node dist/index.js
pnpm test               # Run all test files with tsx
```

Test command runs sequentially:
- `tsx test/abi.test.ts`
- `tsx test/pda.test.ts`
- `tsx test/slab.test.ts`
- `tsx test/validation.test.ts`
- `tsx test/oracle.test.ts`

## Configuration Files

**TypeScript:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tsconfig.json`
  - Target: ES2022, Module: ESNext, ModuleResolution: bundler
  - Strict mode enabled, output to `dist/`, root dir `src/`

**Build:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tsup.config.ts`
  - ESM format, Node 20 target, sourcemaps enabled

**Package:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/package.json`
  - Binary: `percolator-cli` → `./dist/index.js`
  - Published files: `dist/` only

**Environment:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/.env.example`
  - `SOLANA_RPC_URL` — Solana RPC endpoint (default: `https://api.devnet.solana.com`)
  - `WALLET_PATH` — Path to Solana CLI keypair JSON file

**pnpm:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/.npmrc`
  - `shamefully-hoist=true` — pnpm hoisting setting

## Runtime Configuration

**Config file:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/percolator-cli.json`
- `rpcUrl` — Solana RPC endpoint
- `programId` — Percolator program ID (`2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp`)
- `wallet` — Keypair path (default: `~/.config/solana/id.json`)
- `commitment` — Commitment level (default: `confirmed`)

Configuration is loaded by `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/config.ts` with Zod validation.

## Platform Requirements

**Development:**
- Node.js >= 20
- pnpm package manager
- Solana CLI tools (for keypair generation)
- macOS ARM64 (binary dependency `oh-my-opencode-darwin-arm64`)

**Production:**
- Solana mainnet-beta or devnet
- Node.js >= 20 runtime
- Access to a Solana RPC endpoint

---

*Stack analysis: 2026-04-30*
