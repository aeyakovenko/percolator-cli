import { PublicKey } from "@solana/web3.js";

const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^(0|-?[1-9][0-9]*)$/;

const U8_MAX = (1n << 8n) - 1n;
const U16_MAX = (1n << 16n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Invalid ${field}: ${message}`);
    this.name = "ValidationError";
  }
}

function parseDecimal(
  value: string,
  field: string,
  signed: boolean,
): bigint {
  const grammar = signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL;
  if (!grammar.test(value)) {
    throw new ValidationError(
      field,
      signed
        ? "must be a canonical signed decimal integer"
        : "must be a canonical unsigned decimal integer",
    );
  }
  return BigInt(value);
}

function validateUnsigned(
  value: string,
  field: string,
  max: bigint,
  typeName: string,
): bigint {
  const parsed = parseDecimal(value, field, false);
  if (parsed > max) {
    throw new ValidationError(field, `must fit ${typeName}`);
  }
  return parsed;
}

function validateSigned(
  value: string,
  field: string,
  min: bigint,
  max: bigint,
  typeName: string,
): bigint {
  const parsed = parseDecimal(value, field, true);
  if (parsed < min || parsed > max) {
    throw new ValidationError(field, `must fit ${typeName}`);
  }
  return parsed;
}

export function validatePublicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new ValidationError(field, "must be a base58 Solana public key");
  }
}

export function validateU8(value: string, field: string): number {
  return Number(validateUnsigned(value, field, U8_MAX, "u8"));
}

export function validateU16(value: string, field: string): number {
  return Number(validateUnsigned(value, field, U16_MAX, "u16"));
}

export function validateU32(value: string, field: string): number {
  return Number(validateUnsigned(value, field, U32_MAX, "u32"));
}

export function validateU64(value: string, field: string): bigint {
  return validateUnsigned(value, field, U64_MAX, "u64");
}

export function validateU128(value: string, field: string): bigint {
  return validateUnsigned(value, field, U128_MAX, "u128");
}

export function validateI64(value: string, field: string): bigint {
  return validateSigned(value, field, I64_MIN, I64_MAX, "i64");
}

export function validateI128(value: string, field: string): bigint {
  return validateSigned(value, field, I128_MIN, I128_MAX, "i128");
}

export function validateBps(value: string, field: string): number {
  const parsed = validateUnsigned(value, field, 10_000n, "basis points");
  return Number(parsed);
}
