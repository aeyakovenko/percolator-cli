# Architecture

**Analysis Date:** 2026-04-30

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                      CLI Layer (Commander.js)               │
│                  `src/cli.ts`, `src/index.ts`               │
├──────────────────┬──────────────────┬─────────────────────┤
│  Commands Layer  │  Runtime Layer  │   Validation Layer   │
│  `src/commands/`│  `src/runtime/` │   `src/validation`  │
│                  │  context.ts,tx.ts│                     │
└────────┬─────────┴────────┬─────────┴─────────┬───────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    ABI Layer                                │
│         `src/abi/`  (instructions, accounts, encode)       │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Solana Layer                              │
│        `src/solana/`  (slab, wallet, ata, oracle, pda)   │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              Solana Blockchain (Percolator Program)         │
│                   `programId` configured                     │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI Entry | Parse arguments, dispatch to commands | `src/index.ts` |
| CLI Builder | Register commands, define global flags | `src/cli.ts` |
| Config Loader | Load and validate config from file + CLI overrides | `src/config.ts` |
| Runtime Context | Create connection, payer, program ID context | `src/runtime/context.ts` |
| Transaction Executor | Build, simulate, or send transactions | `src/runtime/tx.ts` |
| Instruction Encoder | Encode instruction data for all program instructions | `src/abi/instructions.ts` |
| Account Specs | Define account ordering for each instruction | `src/abi/accounts.ts` |
| Binary Encoder | Low-level encoding utilities (u8, u16, u64, i128, etc.) | `src/abi/encode.ts` |
| Error Decoder | Map program error codes to names and hints | `src/abi/errors.ts` |
| Slab Parser | Parse on-chain slab account data (header, config, engine, accounts) | `src/solana/slab.ts` |
| Wallet Loader | Load keypair from JSON file with ~ expansion | `src/solana/wallet.ts` |
| ATA Helper | Associated token account utilities | `src/solana/ata.ts` |
| Oracle Parser | Parse Chainlink oracle price data | `src/solana/oracle.ts` |
| PDA Deriver | Derive vault authority and LP PDAs | `src/solana/pda.ts` |
| Input Validator | Validate public keys, indices, amounts, bps | `src/validation.ts` |

## Pattern Overview

**Overall:** Modular CLI with command-registration pattern and layered architecture

**Key Characteristics:**
- Each command is a self-contained module that registers itself with the CLI
- Configuration flows from file → CLI flags → runtime context
- Instructions are built by encoding structured data into binary format
- Account specifications are centralized in `src/abi/accounts.ts` as single source of truth
- All numeric types use explicit encoding functions matching Solana/BPF layout
- Validation occurs before any blockchain interaction

## Layers

**CLI Layer:**
- Purpose: Parse user input, route to appropriate command handler
- Location: `src/cli.ts`, `src/index.ts`
- Contains: Commander.js program setup, global options, command registration
- Depends on: All command modules
- Used by: End users via terminal

**Configuration Layer:**
- Purpose: Load and validate configuration from file and CLI flags
- Location: `src/config.ts`
- Contains: Zod schema validation, config file discovery, flag merging
- Depends on: Node.js fs/path, Zod, Solana web3.js
- Used by: CLI commands via `loadConfig()` then `createContext()`

**Runtime Layer:**
- Purpose: Provide execution context and transaction handling
- Location: `src/runtime/context.ts`, `src/runtime/tx.ts`
- Contains: Connection/payer/programId context, transaction building, simulate-or-send logic
- Depends on: `@solana/web3.js`, `src/abi/errors.ts`
- Used by: All commands

**ABI Layer:**
- Purpose: Define binary interface to the on-chain Percolator program
- Location: `src/abi/instructions.ts`, `src/abi/accounts.ts`, `src/abi/encode.ts`, `src/abi/errors.ts`, `src/abi/accounts.ts`
- Contains: Instruction tags, encoders, account specs, error definitions
- Depends on: Node.js Buffer, `@solana/web3.js`
- Used by: Commands when building instructions

**Solana Layer:**
- Purpose: Solana-specific utilities for accounts, oracles, PDAs, wallets
- Location: `src/solana/slab.ts`, `src/solana/wallet.ts`, `src/solana/ata.ts`, `src/solana/oracle.ts`, `src/solana/pda.ts`
- Contains: On-chain data parsers, PDA derivation, oracle price parsing
- Depends on: `@solana/web3.js`, `@solana/spl-token`
- Used by: Commands and ABI layer

**Validation Layer:**
- Purpose: Input validation with descriptive error messages
- Location: `src/validation.ts`
- Contains: Validators for pubkey, index, amount, bps, u64, i64, u128, i128
- Depends on: `@solana/web3.js`
- Used by: Command handlers before processing

## Data Flow

### Primary Command Flow (e.g., trade-cpi)

1. User invokes `percolator-cli trade-cpi --slab <key> --lp-idx 0 --user-idx 1 --size 100` (`src/index.ts:4`)
2. Commander parses arguments, calls registered action handler (`src/commands/trade-cpi.ts:33`)
3. Global flags extracted from command (`src/cli.ts:99-110`)
4. Config loaded from file + CLI overrides, validated with Zod (`src/config.ts:32-62`)
5. Runtime context created: Connection, Keypair, ProgramId, Commitment (`src/runtime/context.ts:18-29`)
6. Input validation: pubkey, index, size (`src/validation.ts`)
7. Slab account fetched and parsed for config/oracle (`src/solana/slab.ts:126-139`)
8. LP PDA derived from programId + slab + lpIdx (`src/solana/pda.ts:21-32`)
9. Instruction data encoded: tag + lpIdx + userIdx + size + limitPrice (`src/abi/instructions.ts:270-278`)
10. Account metas built from spec + provided pubkeys (`src/abi/accounts.ts:394-408`)
11. Transaction instruction built (`src/runtime/tx.ts:23-29`)
12. Transaction simulated or sent (`src/runtime/tx.ts:53-155`)
13. Result formatted and printed (`src/runtime/tx.ts:164-198`)

### Configuration Loading Flow

1. Check for `--config` CLI flag or find `percolator-cli.json` in cwd (`src/config.ts:34-36, 67-70`)
2. Read and parse JSON config file if exists (`src/config.ts:37-44`)
3. Merge: CLI flags override file config, file config overrides defaults (`src/config.ts:47-52`)
4. Validate merged config with Zod schema (`src/config.ts:55-59`)
5. Return typed `Config` object (`src/config.ts:15`)

## Key Abstractions

**Instruction Encoding:**
- Purpose: Define the binary interface to the Percolator on-chain program
- Examples: `src/abi/instructions.ts`, `src/abi/encode.ts`
- Pattern: Each instruction has a tag constant + encode function that returns Buffer

**Account Specification:**
- Purpose: Define the exact account ordering required by each instruction
- Examples: `src/abi/accounts.ts` (e.g., `ACCOUNTS_TRADE_CPI`)
- Pattern: Readonly array of `{name, signer, writable}` objects, used with `buildAccountMetas()`

**Slab Account Layout:**
- Purpose: Parse the large (1.5MB+) on-chain slab account into structured data
- Examples: `src/solana/slab.ts` (parseHeader, parseConfig, parseEngine, parseAccount)
- Pattern: Manual buffer offset reading matching Rust BPF layout (8-byte alignment)

**Runtime Context:**
- Purpose: Provide all dependencies needed by command handlers
- Examples: `src/runtime/context.ts` (Connection, Keypair, PublicKey, Commitment)
- Pattern: Simple interface created once, passed implicitly via closure in command handlers

## Entry Points

**CLI Entry:**
- Location: `src/index.ts`
- Triggers: `node dist/index.js` or `percolator-cli` (via bin in package.json)
- Responsibilities: Create CLI program, parse argv, exit with error code on failure

**Binary Entry (package.json bin):**
- Location: `dist/index.js` (compiled from `src/index.ts`)
- Configured in: `package.json:7`

## Architectural Constraints

- **Threading:** Single-threaded Node.js, no Worker threads used
- **Global state:** Configuration is loaded per-command execution; no module-level mutable state
- **Circular imports:** Not present - clean dependency flow: cli → commands → abi/solana/runtime → validation
- **Solana Web3.js v1:** Uses legacy `@solana/web3.js` v1.x (not v2.x), with `@solana/spl-token` v0.3.x
- **BigInt for large numbers:** u128/i128 values use native BigInt, encoded to Buffer manually
- **BPF layout compatibility:** All slab parsing matches Rust's BPF alignment rules (8-byte alignment for u128/i128)

## Anti-Patterns

### Direct Buffer Offset Reading in Slab Parser

**What happens:** `src/solana/slab.ts` uses manual buffer offset arithmetic (e.g., `off += 8`) to parse the slab account, with offsets scattered across the file matching Rust struct layout.

**Why it's wrong:** A single offset miscalculation causes silent data corruption; changes to the on-chain struct require tedious manual updates to every offset.

**Do this instead:** Generate parsers from a schema or use a struct-definition approach that centralizes field offsets (some fields already documented at top of `src/solana/slab.ts:3-27`).

### Backward-Compatibility Shim in Instruction Module

**What happens:** `encodeSetOracleAuthority()` and `encodeUpdateAdmin()` in `src/abi/instructions.ts:429-438` are shims that delegate to `encodeUpdateAuthority()` with a specific kind discriminator.

**Why it's wrong:** The shim functions exist solely for backward compatibility but obscure the actual wire format; callers may not realize they're emitting the same tag (32) with different kind bytes.

**Do this instead:** Document the shim behavior clearly (already done with JSDoc), and migrate callers to use `encodeUpdateAuthority()` directly.

## Error Handling

**Strategy:** Errors are caught at multiple levels with descriptive messages

**Patterns:**
- **Validation errors:** `ValidationError` class in `src/validation.ts:17-25` with field name + message
- **Config errors:** Thrown with descriptive message when Zod validation fails (`src/config.ts:56-59`)
- **Program errors:** Parsed from transaction logs via `parseErrorFromLogs()` in `src/abi/errors.ts:150-168`, mapped to named errors with hints
- **Transaction errors:** Returned as `TxResult` with `err` field set, process.exitCode set to 1 (`src/runtime/tx.ts:165-167`)
- **Slab parse errors:** Thrown with specific validation messages (magic bytes, version, size)

## Cross-Cutting Concerns

**Logging:** Uses `console.log` / `console.error` directly; no logging framework. JSON mode available via `--json` flag.

**Validation:** Centralized in `src/validation.ts` with type-specific functions (`validatePublicKey`, `validateIndex`, `validateI128`, etc.). Each returns the validated + converted value or throws `ValidationError`.

**Authentication:** Via keypair file (default `~/.config/solana/id.json`, overridable with `--wallet`). Loaded in `src/solana/wallet.ts`.

**Compute Budget:** Transactions can specify custom compute unit limit via `computeUnitLimit` parameter in `simulateOrSend()` (`src/runtime/tx.ts:61-67`).

---

*Architecture analysis: 2026-04-30*
