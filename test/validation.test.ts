/**
 * Validation module tests
 */

import {
  validatePublicKey,
  validateIndex,
  validateAmount,
  validateU128,
  validateI64,
  validateI128,
  validateBps,
  validateU16,
  ValidationError,
} from "../src/validation.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertThrows(fn: () => void, expectedMsg: string, testName: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${testName} - expected to throw`);
  } catch (e) {
    if (e instanceof Error && e.message.includes(expectedMsg)) {
      // OK
    } else if (e instanceof Error && e.message.startsWith("FAIL:")) {
      throw e;
    } else {
      throw new Error(`FAIL: ${testName} - expected "${expectedMsg}" in error, got: ${e}`);
    }
  }
}

console.log("Testing validation functions...\n");

// validatePublicKey tests
{
  const pk = validatePublicKey("11111111111111111111111111111111", "--slab");
  assert(pk.toBase58() === "11111111111111111111111111111111", "valid system pubkey");

  const pk2 = validatePublicKey("3K1P8KXJHg4Uk2upGiorjjFdSxGxq2sjxrrFaBjZ34D9", "--slab");
  assert(pk2.toBase58() === "3K1P8KXJHg4Uk2upGiorjjFdSxGxq2sjxrrFaBjZ34D9", "valid real pubkey");

  assertThrows(
    () => validatePublicKey("invalid", "--slab"),
    "not a valid base58",
    "rejects invalid pubkey"
  );

  assertThrows(
    () => validatePublicKey("", "--slab"),
    "not a valid base58",
    "rejects empty string"
  );

  console.log("✓ validatePublicKey");
}

// validateIndex tests
{
  assert(validateIndex("0", "--idx") === 0, "accepts zero");
  assert(validateIndex("123", "--idx") === 123, "accepts positive");
  assert(validateIndex("65535", "--idx") === 65535, "accepts u16 max");

  assertThrows(() => validateIndex("-1", "--idx"), "non-negative", "rejects negative");
  assertThrows(() => validateIndex("65536", "--idx"), "65535", "rejects above u16 max");
  assertThrows(() => validateIndex("abc", "--idx"), "not a valid number", "rejects non-numeric");

  console.log("✓ validateIndex");
}

// validateAmount tests
{
  assert(validateAmount("0", "--amt") === 0n, "accepts zero");
  assert(validateAmount("1000000000000", "--amt") === 1000000000000n, "accepts large");
  assert(validateAmount("18446744073709551615", "--amt") === 18446744073709551615n, "accepts u64 max");

  assertThrows(() => validateAmount("-100", "--amt"), "non-negative", "rejects negative");
  assertThrows(() => validateAmount("18446744073709551616", "--amt"), "u64 max", "rejects above max");
  assertThrows(() => validateAmount("abc", "--amt"), "not a valid number", "rejects non-numeric");

  console.log("✓ validateAmount");
}

// validateU128 tests
{
  assert(validateU128("0", "--val") === 0n, "accepts zero");
  const u128Max = "340282366920938463463374607431768211455";
  assert(validateU128(u128Max, "--val") === 340282366920938463463374607431768211455n, "accepts u128 max");

  assertThrows(() => validateU128("-1", "--val"), "non-negative", "rejects negative");
  assertThrows(() => validateU128("340282366920938463463374607431768211456", "--val"), "u128 max", "rejects above max");

  console.log("✓ validateU128");
}

// validateI64 tests
{
  assert(validateI64("0", "--val") === 0n, "accepts zero");
  assert(validateI64("1000", "--val") === 1000n, "accepts positive");
  assert(validateI64("-1000", "--val") === -1000n, "accepts negative");
  assert(validateI64("9223372036854775807", "--val") === 9223372036854775807n, "accepts i64 max");
  assert(validateI64("-9223372036854775808", "--val") === -9223372036854775808n, "accepts i64 min");

  assertThrows(() => validateI64("9223372036854775808", "--val"), "i64 max", "rejects above max");
  assertThrows(() => validateI64("-9223372036854775809", "--val"), "i64 min", "rejects below min");

  console.log("✓ validateI64");
}

// validateI128 tests
{
  assert(validateI128("0", "--size") === 0n, "accepts zero");
  assert(validateI128("500", "--size") === 500n, "accepts positive");
  assert(validateI128("-500", "--size") === -500n, "accepts negative");

  const i128Max = "170141183460469231731687303715884105727";
  assert(validateI128(i128Max, "--size") === 170141183460469231731687303715884105727n, "accepts i128 max");

  const i128Min = "-170141183460469231731687303715884105728";
  assert(validateI128(i128Min, "--size") === -170141183460469231731687303715884105728n, "accepts i128 min");

  assertThrows(() => validateI128("170141183460469231731687303715884105728", "--size"), "i128 max", "rejects above max");
  assertThrows(() => validateI128("-170141183460469231731687303715884105729", "--size"), "i128 min", "rejects below min");

  console.log("✓ validateI128");
}

// validateBps tests
{
  assert(validateBps("0", "--bps") === 0, "accepts zero");
  assert(validateBps("10000", "--bps") === 10000, "accepts 100%");
  assert(validateBps("5000", "--bps") === 5000, "accepts 50%");

  assertThrows(() => validateBps("-1", "--bps"), "non-negative", "rejects negative");
  assertThrows(() => validateBps("10001", "--bps"), "10000", "rejects above 100%");

  console.log("✓ validateBps");
}

// ValidationError tests
{
  const err = new ValidationError("--amount", "must be positive");
  assert(err.message.includes("--amount"), "error includes field");
  assert(err.message.includes("must be positive"), "error includes message");
  assert(err.name === "ValidationError", "error has correct name");
  assert(err.field === "--amount", "error has field property");

  console.log("✓ ValidationError");
}

console.log("\n✅ All validation tests passed!");
