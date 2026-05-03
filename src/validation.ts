/**
 * Input validation utilities for CLI commands.
 * Provides descriptive error messages for invalid input.
 */

import { PublicKey } from "@solana/web3.js";

// Constants for numeric limits
const U8_MAX = 255;
const U16_MAX = 65535;
const U32_MAX = 4294967295;
const U64_MAX = BigInt("18446744073709551615");
const I64_MIN = BigInt("-9223372036854775808");
const I64_MAX = BigInt("9223372036854775807");
const U128_MAX = (1n << 128n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

/**
 * Strict decimal-integer parse. Rejects scientific notation ("1e9"),
 * fractional ("3.7"), suffix garbage ("123abc"), hex ("0x10"),
 * leading/trailing whitespace (" 5 "), empty string, NaN, and
 * Infinity. parseInt accepts all of these silently and we encode the
 * truncated result onto the wire — see #66 / #67.
 */
function parseStrictUInt(value: string, field: string): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(
      field,
      `"${value}" is not a strict non-negative decimal integer (rejecting scientific notation, fractions, hex, whitespace, suffix garbage)`
    );
  }
  // Disallow values past Number.MAX_SAFE_INTEGER — at u53 the integer
  // semantics start losing precision and downstream encU8/encU16/encU32
  // would silently mis-encode. Callers that need wider ranges should
  // use validateAmount / validateU128 (BigInt-backed).
  const num = Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new ValidationError(
      field,
      `${value} exceeds Number.MAX_SAFE_INTEGER; use a BigInt-backed validator`
    );
  }
  return num;
}

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(`Invalid ${field}: ${message}`);
    this.name = "ValidationError";
  }
}

/**
 * Validate a public key string.
 */
export function validatePublicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid base58 public key. ` +
        `Example: "11111111111111111111111111111111"`
    );
  }
}

/**
 * Validate a non-negative integer index (u16 range for accounts).
 */
export function validateIndex(value: string, field: string): number {
  const num = parseStrictUInt(value, field);
  if (num > U16_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U16_MAX} (u16 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate a non-negative amount (u64 range).
 */
export function validateAmount(value: string, field: string): bigint {
  let num: bigint;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only.`
    );
  }
  if (num < 0n) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > U64_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U64_MAX} (u64 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate a u128 value.
 */
export function validateU128(value: string, field: string): bigint {
  let num: bigint;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only.`
    );
  }
  if (num < 0n) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > U128_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U128_MAX} (u128 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate an i64 value.
 */
export function validateI64(value: string, field: string): bigint {
  let num: bigint;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only, with optional leading minus.`
    );
  }
  if (num < I64_MIN) {
    throw new ValidationError(
      field,
      `must be >= ${I64_MIN} (i64 min), got ${num}`
    );
  }
  if (num > I64_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${I64_MAX} (i64 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate an i128 value (trade sizes).
 */
export function validateI128(value: string, field: string): bigint {
  let num: bigint;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only, with optional leading minus.`
    );
  }
  if (num < I128_MIN) {
    throw new ValidationError(
      field,
      `must be >= ${I128_MIN} (i128 min), got ${num}`
    );
  }
  if (num > I128_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${I128_MAX} (i128 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate a basis points value (0-10000).
 */
export function validateBps(value: string, field: string): number {
  const num = parseStrictUInt(value, field);
  if (num > 10000) {
    throw new ValidationError(
      field,
      `must be <= 10000 (100%), got ${num}`
    );
  }
  return num;
}

/**
 * Validate a u64 value.
 */
export function validateU64(value: string, field: string): bigint {
  return validateAmount(value, field);
}

/**
 * Validate a u16 value.
 */
export function validateU16(value: string, field: string): number {
  const num = parseStrictUInt(value, field);
  if (num > U16_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U16_MAX} (u16 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate a u8 value (0..=255). Use for narrow enum-style flags
 * (`invert`, kind tags, etc.).
 */
export function validateU8(value: string, field: string): number {
  const num = parseStrictUInt(value, field);
  if (num > U8_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U8_MAX} (u8 max), got ${num}`
    );
  }
  return num;
}

/**
 * Validate a u32 value. Use for compute-unit limits, unit_scale, etc.
 */
export function validateU32(value: string, field: string): number {
  const num = parseStrictUInt(value, field);
  if (num > U32_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U32_MAX} (u32 max), got ${num}`
    );
  }
  return num;
}
