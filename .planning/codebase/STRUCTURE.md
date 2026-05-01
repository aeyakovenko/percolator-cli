# Codebase Structure

**Analysis Date:** 2026-04-30

## Directory Layout

```
percolator-cli/
├── src/                   # Source code (TypeScript)
│   ├── abi/              # Binary interface to on-chain program
│   ├── commands/         # CLI command implementations
│   ├── runtime/          # Execution context and transaction handling
│   └── solana/          # Solana-specific utilities
├── test/                 # Unit tests (tsx-based)
├── tests/                # Integration/e2e tests (harness-based)
├── docs/                 # Documentation
│   └── audit/            # Audit-related docs
├── scripts/              # Build/utility scripts
├── dist/                 # Compiled output (generated, committed)
├── node_modules/         # Dependencies (not committed)
└── .planning/            # Planning documents
    └── codebase/         # Codebase analysis documents
```

## Directory Purposes

**`src/`**:
- Purpose: Main source code directory
- Contains: All TypeScript source files organized by layer
- Key files: `index.ts` (entry), `cli.ts` (CLI setup)

**`src/abi/`**:
- Purpose: Binary interface definitions for the Percolator on-chain program
- Contains: Instruction encoders, account specs, binary encoding utilities, error definitions
- Key files: `instructions.ts`, `accounts.ts`, `encode.ts`, `errors.ts`, `accounts.ts`

**`src/commands/`**:
- Purpose: Individual CLI command implementations
- Contains: One file per command (or logical group), each exports a `registerXxx(program)` function
- Key files: `trade-cpi.ts`, `init-market.ts`, `list-markets.ts`, etc. (27 command files)

**`src/runtime/`**:
- Purpose: Runtime execution support
- Contains: Context creation, transaction building/sending
- Key files: `context.ts`, `tx.ts`

**`src/solana/`**:
- Purpose: Solana blockchain interaction utilities
- Contains: Slab account parsing, wallet loading, ATA helpers, oracle parsing, PDA derivation
- Key files: `slab.ts`, `wallet.ts`, `ata.ts`, `oracle.ts`, `pda.ts`

**`test/`**:
- Purpose: Unit tests for core modules
- Contains: Tests for ABI encoding, PDA derivation, slab parsing, validation
- Key files: `abi.test.ts`, `pda.test.ts`, `slab.test.ts`, `validation.test.ts`, `oracle.test.ts`

**`tests/`**:
- Purpose: Integration and end-to-end tests
- Contains: Test harness, market lifecycle tests, trading scenarios, edge cases
- Key files: `runner.ts`, `harness.ts`, `t1-market-boot.ts` through `t22-devnet-stress.ts`

**`docs/`**:
- Purpose: Project documentation
- Contains: Audit docs and other markdown documentation
- Key files: In `docs/audit/` subdirectory

## Key File Locations

**Entry Points:**
- `src/index.ts`: CLI entry point, creates and parses CLI arguments
- `package.json` (line 7): Defines `bin` as `dist/index.js`

**Configuration:**
- `src/config.ts`: Config loading with Zod validation
- `percolator-cli.json` (runtime): User config file (not in repo, created by user)
- `tsup.config.ts`: Build configuration for tsup

**Core Logic:**
- `src/cli.ts`: CLI program setup, global options, command registration
- `src/abi/instructions.ts`: All program instruction encoders
- `src/abi/accounts.ts`: Account specifications for all instructions
- `src/solana/slab.ts`: On-chain slab account parser (1.5MB layout)

**Runtime:**
- `src/runtime/context.ts`: Runtime context (connection, payer, programId)
- `src/runtime/tx.ts`: Transaction building, simulate/send, result formatting

**Validation:**
- `src/validation.ts`: Input validation functions with descriptive errors

## Naming Conventions

**Files:**
- Command files: `kebab-case.ts` matching CLI command name (e.g., `trade-cpi.ts`, `init-market.ts`)
- ABI files: `kebab-case.ts` by concern (e.g., `instructions.ts`, `accounts.ts`, `encode.ts`)
- Runtime files: `kebab-case.ts` (e.g., `context.ts`, `tx.ts`)
- Solana files: `kebab-case.ts` (e.g., `slab.ts`, `wallet.ts`, `oracle.ts`)

**Functions:**
- Export functions: `camelCase` (e.g., `encodeInitMarket`, `parseHeader`, `loadConfig`)
- Register functions: `camelCase` with `register` prefix (e.g., `registerTradeCpi`, `registerInitMarket`)
- Validation functions: `camelCase` with `validate` prefix (e.g., `validatePublicKey`, `validateIndex`)

**Constants:**
- Instruction tags: `UPPER_SNAKE_CASE` (e.g., `IX_TAG.InitMarket`, `IX_TAG.TradeCpi`)
- Account specs: `UPPER_SNAKE_CASE` (e.g., `ACCOUNTS_INIT_MARKET`, `ACCOUNTS_TRADE_CPI`)
- Encoder functions: `camelCase` with `enc` prefix (e.g., `encU8`, `encU64`, `encI128`)

**Types/Interfaces:**
- PascalCase (e.g., `Context`, `Config`, `GlobalFlags`, `SlabHeader`, `MarketConfig`)

## Where to Add New Code

**New Command:**
- Primary code: `src/commands/<command-name>.ts`
- Follow pattern: export `registerXxx(program: Command)` function
- Import and register in `src/cli.ts` (import + call `registerXxx(program)`)
- If new instruction: add encoder in `src/abi/instructions.ts`, add tag to `IX_TAG`
- If new account layout: add spec in `src/abi/accounts.ts`

**New ABI Instruction:**
- Add tag to `IX_TAG` in `src/abi/instructions.ts`
- Add encoder function (e.g., `encodeXxx()`) in `src/abi/instructions.ts`
- If new accounts needed: add `ACCOUNTS_XXX` spec in `src/abi/accounts.ts`
- Export new encoder from the module

**New Solana Utility:**
- Add file or function in `src/solana/` (e.g., `src/solana/<new-util>.ts`)
- Follow existing patterns: export functions, use `@solana/web3.js` types

**New Validation:**
- Add validator function in `src/validation.ts`
- Follow pattern: throws `ValidationError` with field name and message
- Return validated + converted value

**New Test:**
- Unit test: `test/<module>.test.ts` (run with `tsx test/<module>.test.ts`)
- Integration test: `tests/t<N>-<description>.ts` (requires test harness)

## Special Directories

**`dist/`**:
- Purpose: Compiled JavaScript output from tsup
- Generated: Yes (from `src/index.ts` and dependencies)
- Committed: Yes (defined in `package.json` `"files": ["dist"]`)
- Build command: `pnpm build` or `tsup`

**`node_modules/`**:
- Purpose: Dependencies installed by pnpm
- Generated: Yes
- Committed: No (in `.gitignore`)

**`.planning/`**:
- Purpose: Planning documents for GSD workflow
- Generated: No (hand-written analysis documents)
- Committed: Yes

**`tests/`**:
- Purpose: Integration and e2e tests with harness
- Generated: No
- Committed: Yes
- Note: More extensive than `test/`; contains multi-step scenarios

## Build and Output

**Build Tool:** tsup (`tsup.config.ts`)
- Entry: `src/index.ts`
- Format: ESM (ECMAScript modules)
- Target: Node 20
- Output: `dist/` directory
- Banner: `#!/usr/bin/env node` (makes output executable)
- Sourcemaps: Generated

**Run Commands:**
```bash
pnpm build          # Build the CLI
pnpm dev            # Build and run
pnpm test           # Run all unit tests
```

---

*Structure analysis: 2026-04-30*
