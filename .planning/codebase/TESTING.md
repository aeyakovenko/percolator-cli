# Testing Patterns

**Analysis Date:** 2026-04-30

## Summary

The project uses a custom lightweight testing approach with no dedicated test framework. Unit tests are standalone TypeScript files that use `tsx` to run and a custom `assert`/`assertThrows` pattern. Integration tests in `/tests/` provide end-to-end validation using a devnet harness with invariant checking.

## Test Framework

**Runner:**
- No dedicated test framework (Jest, Vitest, Mocha, etc.)
- Tests run directly with `tsx` (TypeScript execution tool)
- Custom assertion functions: `assert()` and `assertThrows()`

**Assertion Approach:**
- Simple throw-based assertions defined per test file
- Pattern from `/test/abi.test.ts:30-34`:
  ```typescript
  function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  }
  ```
- Error testing with `assertThrows()` from `/test/abi.test.ts:21-34`

**Run Commands:**
```bash
pnpm test                          # Run all unit tests sequentially
tsx test/abi.test.ts               # Run single test file
tsx test/pda.test.ts               # Run PDA derivation tests
tsx test/slab.test.ts              # Run slab parsing tests
tsx test/validation.test.ts        # Run validation tests
tsx test/oracle.test.ts            # Run oracle parsing tests
```

## Test File Organization

**Location:**
- Unit tests: `/test/` directory at project root
- Integration tests: `/tests/` directory (harness-based, devnet tests)
- Co-located with source: No (separate `/test/` and `/tests/` directories)

**Naming:**
- Unit tests: `[topic].test.ts` - `abi.test.ts`, `pda.test.ts`, `slab.test.ts`
- Integration tests: `t[N]-[description].ts` - `t1-market-boot.ts`, `t2-user-lifecycle.ts`

**Structure:**
```
/test/
├── abi.test.ts          # ABI encoding tests
├── pda.test.ts          # PDA derivation tests
├── slab.test.ts         # Slab parsing tests
├── validation.test.ts   # Input validation tests
└── oracle.test.ts       # Oracle parsing tests

/tests/
├── harness.ts           # Test harness with devnet setup
├── invariants.ts        # Invariant checking logic
├── runner.ts            # Test runner
├── preflight.ts         # Pre-flight checks
└── t1-market-boot.ts    # Integration test scenarios
```

## Test Structure

**Unit Test Pattern:**
- Tests wrapped in inline blocks with descriptive labels
- Console output with checkmark on success: `console.log("✓ encodeU8");`
- Pattern from `/test/abi.test.ts:45-50`:
  ```typescript
  {
    assertBuf(encU8(0), [0], "encU8(0)");
    assertBuf(encU8(255), [255], "encU8(255)");
    console.log("✓ encU8");
  }
  ```

**Suite Organization:**
- No formal test suites or describe blocks
- Tests grouped by function under comments: `// validatePublicKey tests`
- Each test file covers one module/topic

## Mocking

**Framework:** None - custom mock builders

**Patterns:**
- Mock data builders for buffer-based tests
- Pattern from `/test/slab.test.ts:22-39`:
  ```typescript
  function createMockSlab(): Buffer {
    const buf = Buffer.alloc(592);
    buf.writeBigUInt64LE(0x504552434f4c4154n, 0); // magic
    // ... set fields
    return buf;
  }
  ```

**What to Mock:**
- Solana account data with manually constructed buffers
- PublicKey with `PublicKey.unique()` for isolated tests (`/test/pda.test.ts:12-13`)

**What NOT to Mock:**
- Integration tests (`/tests/`) use real devnet connections
- Transaction simulation via `simulateOrSend()` with `simulate: true`

## Fixtures and Factories

**Test Data:**
- Inline test data with expected values
- Buffer builders for binary data tests
- Pattern from `/test/oracle.test.ts:33-38`:
  ```typescript
  function buildChainlinkBuffer(decimals: number, answer: bigint, size = 256): Buffer {
    const buf = Buffer.alloc(size);
    buf.writeUInt8(decimals, 138);
    buf.writeBigInt64LE(answer, 216);
    return buf;
  }
  ```

**Location:**
- Fixtures defined at top of test files
- No shared fixture directory

## Coverage

**Requirements:** None enforced

**Current Coverage:**
- ABI encoding (`/test/abi.test.ts`)
- PDA derivation (`/test/pda.test.ts`)
- Slab parsing (`/test/slab.test.ts`)
- Input validation (`/test/validation.test.ts`)
- Oracle parsing (`/test/oracle.test.ts`)
- 23 integration test scenarios in `/tests/`

## Test Types

**Unit Tests:**
- Scope: Individual functions in isolation
- Approach: Direct function calls with expected inputs/outputs
- Location: `/test/*.test.ts`

**Integration Tests:**
- Scope: Full market lifecycle on devnet
- Approach: Test harness (`/tests/harness.ts`) with setup, execution, verification
- Pattern: `describe`-style lifecycle (t1 through t22 files)
- Invariant checking: `/tests/invariants.ts` verifies conservation, consistency

**E2E Tests:**
- Framework: Custom harness using real Solana devnet
- Files: `/tests/t21-live-trading.ts`, `/tests/t19-pyth-live-prices.ts`
- Requires `.env` configuration with valid RPC and wallet

## Common Patterns

**Async Testing:**
```typescript
// From /test/pda.test.ts
const [pda, bump] = deriveVaultAuthority(programId, slab);
assert(pda instanceof PublicKey, "vault authority is PublicKey");
```

**Error Testing:**
```typescript
// From /test/validation.test.ts:21-34
function assertThrows(fn: () => void, expectedMsg: string, testName: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${testName} - expected to throw`);
  } catch (e) {
    if (e instanceof Error && e.message.includes(expectedMsg)) {
      // OK - expected error
    }
  }
}
```

**Buffer Comparison:**
```typescript
// From /test/abi.test.ts:34-41
function assertBuf(actual: Buffer, expected: number[], msg: string): void {
  const exp = Buffer.from(expected);
  if (!actual.equals(exp)) {
    throw new Error(`FAIL: ${msg}\n  expected: [${[...exp].join(", ")}]\n  actual:   [${[...actual].join(", ")}]`);
  }
}
```

## Key Files

- `/test/abi.test.ts` - ABI encoding test patterns
- `/test/pda.test.ts` - PDA derivation test patterns
- `/test/validation.test.ts` - Validation error testing patterns
- `/test/slab.test.ts` - Buffer parsing test patterns
- `/test/oracle.test.ts` - Oracle data parsing patterns
- `/tests/harness.ts` - Integration test harness (43KB)
- `/tests/invariants.ts` - Invariant checking logic (13KB)
- `/tests/runner.ts` - Integration test runner
- `/package.json` - Test script definition (line 15)

---

*Testing analysis: 2026-04-30*
