# Codebase Concerns

**Analysis Date:** 2026-04-30

## Summary

This is a Solana-based CLI tool for interacting with the Percolator trading protocol. The codebase is well-structured with good TypeScript strict mode usage, but has several concerns around platform-specific dependencies, heavy use of `any` types in scripts, sequential processing patterns, and limited unit test coverage for core source files.

## Details

### 1. Platform-Specific Dependency in Core Dependencies

**Issue:** The `oh-my-opencode-darwin-arm64` package (^3.17.6) is included in the main `dependencies` section of `package.json`, not as an optional or platform-specific dependency.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/package.json` (line 23)

**Impact:** This package will cause installation failures on Linux, Windows, or Intel-based Macs. Users on non-darwin-arm64 platforms cannot install or use the CLI.

**Evidence:**
```json
"dependencies": {
  "oh-my-opencode-darwin-arm64": "^3.17.6",
  ...
}
```

---

### 2. Heavy `any` Type Usage in Scripts

**Issue:** Several script and test files use `any` type extensively, bypassing TypeScript's type safety.

**Files:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/scripts/random-traders.ts` (lines 586, 596, 628, 642, 716, 862, 1002)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/scripts/test-comprehensive.ts` (lines 75, 83, 85, 208, 222, 233, 243, 253, 267, 279, 293)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/scripts/dump-market.ts` (lines 36, 41)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/close-all-slabs.ts` (lines 44, 129)

**Impact:** Reduces type safety and may hide potential runtime errors during development.

---

### 3. Sequential Processing for Batch Operations

**Issue:** The `close-all-slabs` command processes slabs one at a time in a sequential `for` loop, which can be slow for large numbers of slabs.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/close-all-slabs.ts` (lines 89-133)

**Impact:** Closing many slabs sequentially can take a long time. No batching or parallel processing is implemented.

**Current pattern:**
```typescript
for (const { pubkey, account } of toClose) {
  try {
    // ... process one slab at a time
  } catch (e: any) { ... }
}
```

---

### 4. Large Script/Test Files

**Issue:** Several files exceed 1000 lines, which may indicate they should be refactored into smaller modules.

**Files:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tests/preflight.ts` (2023 lines)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tests/harness.ts` (1423 lines)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/tests/t21-live-trading.ts` (1097 lines)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/scripts/random-traders.ts` (1027 lines)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/scripts/test-comprehensive.ts` (899 lines)

**Impact:** Large files are harder to maintain, test, and review.

---

### 5. Limited Unit Test Coverage for Source Code

**Issue:** The test script in `package.json` only runs tests in the `tests/` directory (ABI, PDA, slab, validation, oracle tests). There are no dedicated unit tests for the `src/` directory commands, runtime, or utility functions.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/package.json` (line 15)

**Impact:** Core logic in `src/commands/`, `src/runtime/`, and `src/solana/` lacks automated test coverage. Bugs in these areas may only be caught during integration testing or manual testing.

**Current test command:**
```json
"test": "tsx test/abi.test.ts && tsx test/pda.test.ts && tsx test/slab.test.ts && tsx test/validation.test.ts && tsx test/oracle.test.ts"
```

---

### 6. Console Logging Instead of Structured Logging

**Issue:** The codebase uses `console.log` and `console.error` directly throughout for output, with no structured logging framework.

**Files:**
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/index.ts` (line 9)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/close-all-slabs.ts` (multiple lines)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/liquidate-at-oracle.ts` (line 55)
- `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/withdraw.ts` (line 99)
- And many more command files

**Impact:** No log levels, filtering, or structured output. In production/CI environments, this makes log analysis difficult.

---

### 7. Hardcoded RPC Fallback

**Issue:** The config loader has a hardcoded fallback to Solana mainnet RPC URL if no RPC is specified.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/config.ts` (line 48)

**Code:**
```typescript
rpcUrl: flags.rpc ?? fileConfig.rpcUrl ?? "https://api.mainnet-beta.solana.com",
```

**Impact:** Users may unknowingly hit the public RPC rate limits. There is no warning when using the default RPC.

---

### 8. Deprecated/Deleted Instruction Tracking

**Issue:** The ABI instructions file manually tracks deleted instructions with comments, which could become outdated.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/abi/instructions.ts` (lines 15-19, 37)

**Evidence:**
```typescript
// Deleted: 11 SetRiskThreshold, 12 UpdateAdmin, 15 SetMaintenanceFee,
//          16 SetOracleAuthority, 22 SetInsuranceWithdrawPolicy,
//          23...
// 18 SetOraclePriceCap deleted in v12.21
```

**Impact:** As the protocol evolves, these comments may become stale. Consider generating this from the Rust source or a canonical ABI spec.

---

### 9. Slab Size Hardcoded

**Issue:** The slab size is hardcoded in `close-all-slabs.ts` as a constant.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/commands/close-all-slabs.ts` (line 18)

**Code:**
```typescript
const SLAB_SIZE = 1525624; // Expected slab size (new engine layout)
```

**Impact:** If the on-chain program changes the slab layout, this constant must be manually updated. No validation or error message explains a mismatch.

---

### 10. Wallet File Path Handling

**Issue:** The default wallet path in config uses `~/.config/solana/id.json` but the code uses `process.env.HOME` for resolution in some places, which may not work consistently across platforms.

**File:** `/Users/vandopha/Downloads/PersonalSideProjects/percolator-cli/src/config.ts` (line 50)

**Code:**
```typescript
wallet: flags.wallet ?? fileConfig.wallet ?? "~/.config/solana/id.json",
```

**Impact:** The `~` tilde expansion may not be handled consistently. The `wallet.ts` file likely handles this, but it's worth verifying cross-platform behavior.

---

## Recommendations

1. **Fix platform-specific dependency:** Move `oh-my-opencode-darwin-arm64` to optional dependencies or use optional peer dependencies with platform detection.

2. **Add type safety in scripts:** Refactor scripts to use proper TypeScript types instead of `any`. Consider creating shared interfaces for test state.

3. **Implement batch processing:** For `close-all-slabs`, implement batching or parallel processing with concurrency limits to improve performance.

4. **Increase test coverage:** Add unit tests for `src/commands/`, `src/runtime/`, and `src/solana/` modules. Consider using a test framework with mocking for RPC calls.

5. **Add structured logging:** Implement a minimal logging utility with log levels (info, warn, error) that can be toggled via a `--verbose` flag.

6. **Warn on default RPC:** Add a warning message when the default mainnet RPC is being used to encourage users to configure a dedicated RPC endpoint.

7. **Validate slab size dynamically:** Instead of hardcoding slab size, consider fetching the expected size from the program or making it configurable with a helpful error message on mismatch.

8. **Refactor large files:** Break down files over 1000 lines into smaller, focused modules with clear responsibilities.

---

*Concerns audit: 2026-04-30*
