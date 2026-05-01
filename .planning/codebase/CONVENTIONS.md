# Coding Conventions

**Analysis Date:** 2026-04-30

## Summary

The percolator-cli codebase follows strict TypeScript conventions with ES modules, explicit type annotations, and custom validation patterns. Code uses kebab-case for command files and camelCase for utility modules, with JSDoc documentation throughout.

## Naming Patterns

**Files:**
- Commands: kebab-case with descriptive names - `deposit.ts`, `trade-cpi.ts`, `close-account.ts` (`/src/commands/`)
- Utilities: camelCase - `encode.ts`, `slab.ts`, `tx.ts`, `context.ts` (`/src/` subdirectories)
- Tests: kebab-case with `.test.ts` suffix - `abi.test.ts`, `slab.test.ts` (`/test/`)

**Functions and Variables:**
- camelCase for functions and variables: `encodeDepositCollateral`, `validatePublicKey`, `slabPk` (`/src/validation.ts`, `/src/commands/deposit.ts`)
- PascalCase for exported types and interfaces: `SlabHeader`, `MarketConfig`, `Context`, `TxResult` (`/src/solana/slab.ts`, `/src/runtime/context.ts`)

**Constants:**
- UPPER_SNAKE_CASE for constants: `HEADER_LEN`, `CONFIG_LEN`, `SLAB_LEN`, `MAGIC` (`/src/solana/slab.ts`)
- UPPER_SNAKE_CASE for validation limits: `U16_MAX`, `U64_MAX`, `I64_MIN` (`/src/validation.ts`)

## Code Style

**Formatting:**
- No ESLint or Prettier configuration detected in project root
- TypeScript strict mode enabled (`"strict": true` in `/tsconfig.json`)
- 2-space indentation (observed throughout codebase)
- Semicolons used consistently

**TypeScript Configuration (`/tsconfig.json`):**
- Target: ES2022
- Module: ESNext with bundler resolution
- ES module interop enabled
- Force consistent casing in file names

**Imports:**
- ES module syntax with `.js` extensions for local imports: `import { loadConfig } from "../config.js"` (`/src/commands/deposit.ts:3`)
- Named imports preferred over default imports
- External packages imported without extension: `import { PublicKey } from "@solana/web3.js"`

**JSDoc Documentation:**
- JSDoc comments on all exported functions and interfaces
- Parameter and return type descriptions included
- Example from `/src/validation.ts:28-40`:
  ```typescript
  /**
   * Validate a public key string.
   */
  export function validatePublicKey(value: string, field: string): PublicKey {
  ```

## Error Handling

**Custom Error Classes:**
- `ValidationError` class extends Error with `field` property (`/src/validation.ts:17-25`)
- Error messages include field context: `Invalid ${field}: ${message}`

**Error Handling Patterns:**
- Try-catch with specific error type checking: `if (e instanceof Error && e.message.includes(expectedMsg))` (`/test/abi.test.ts:26-32`)
- Functions validate inputs and throw early: `validatePublicKey()`, `validateAmount()` (`/src/validation.ts`)
- Transaction results use `TxResult` interface with `err` string or null (`/src/runtime/tx.ts:31-38`)

**CLI Error Output:**
- `process.exitCode = 1` set for CLI errors without aborting mid-print (`/src/runtime/tx.ts:166`)
- Error hints provided via `hint` field in results

## Module Design

**Exports:**
- Named exports preferred: `export function encodeU8()`, `export interface SlabHeader` (`/src/abi/encode.ts`)
- Selective re-exports in index files where needed

**Barrel Files:**
- Not used - direct imports from specific files
- Commands register themselves via `registerXxx()` functions exported from command files

## Comments

**When to Comment:**
- ABI layout offsets documented extensively in `/src/solana/slab.ts` (e.g., "admin at [0..32], bump at [12]")
- Version-specific changes commented with version numbers: "v12.21+: ..." (`/src/solana/slab.ts:5-16`)
- Complex buffer manipulation explained with byte offsets

**Comment Style:**
- JSDoc for public APIs
- Inline comments for non-obvious logic
- Block comments for sections within files (e.g., `// ============================================================================`)

## Function Design

**Size:**
- Functions generally under 50 lines
- Large operations broken into helper functions (e.g., `encodeInitMarket()` in `/src/abi/instructions.ts`)

**Parameters:**
- Options objects for functions with multiple parameters: `{ programId, keys, data }` (`/src/runtime/tx.ts:14-18`)
- Destructured parameters in function signatures

**Return Values:**
- Result objects with consistent shape: `TxResult`, `TestResult`, `InvariantResult`
- `Promise<T>` for async functions

## Key Files

- `/tsconfig.json` - TypeScript compiler configuration
- `/package.json` - Package config, scripts, dependencies
- `/src/validation.ts` - Input validation patterns and error classes
- `/src/runtime/tx.ts` - Transaction building and execution patterns
- `/src/solana/slab.ts` - ABI parsing with extensive documentation
- `/src/commands/deposit.ts` - Example command module structure
- `/src/abi/encode.ts` - Encoding utility functions

---

*Convention analysis: 2026-04-30*
