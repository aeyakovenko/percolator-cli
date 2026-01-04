import { PublicKey } from "@solana/web3.js";

/**
 * Encode u8 (1 byte)
 */
export function encU8(val: number): Buffer {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(val, 0);
  return buf;
}

/**
 * Encode u16 little-endian (2 bytes)
 */
export function encU16(val: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(val, 0);
  return buf;
}

/**
 * Encode u32 little-endian (4 bytes)
 */
export function encU32(val: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(val, 0);
  return buf;
}

/**
 * Encode u64 little-endian (8 bytes)
 * Input: bigint or string (decimal)
 */
export function encU64(val: bigint | string): Buffer {
  const n = typeof val === "string" ? BigInt(val) : val;
  if (n < 0n) throw new Error("encU64: value must be non-negative");
  if (n > 0xffff_ffff_ffff_ffffn) throw new Error("encU64: value exceeds u64 max");
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

/**
 * Encode i64 little-endian (8 bytes), two's complement
 * Input: bigint or string (decimal, may be negative)
 */
export function encI64(val: bigint | string): Buffer {
  const n = typeof val === "string" ? BigInt(val) : val;
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (n < min || n > max) throw new Error("encI64: value out of range");
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(n, 0);
  return buf;
}

/**
 * Encode u128 little-endian (16 bytes)
 * Input: bigint or string (decimal)
 */
export function encU128(val: bigint | string): Buffer {
  const n = typeof val === "string" ? BigInt(val) : val;
  if (n < 0n) throw new Error("encU128: value must be non-negative");
  const max = (1n << 128n) - 1n;
  if (n > max) throw new Error("encU128: value exceeds u128 max");
  const buf = Buffer.alloc(16);
  // Write as two u64 little-endian parts
  const lo = n & 0xffff_ffff_ffff_ffffn;
  const hi = n >> 64n;
  buf.writeBigUInt64LE(lo, 0);
  buf.writeBigUInt64LE(hi, 8);
  return buf;
}

/**
 * Encode i128 little-endian (16 bytes), two's complement
 * Input: bigint or string (decimal, may be negative)
 */
export function encI128(val: bigint | string): Buffer {
  const n = typeof val === "string" ? BigInt(val) : val;
  const min = -(1n << 127n);
  const max = (1n << 127n) - 1n;
  if (n < min || n > max) throw new Error("encI128: value out of range");

  // Convert to unsigned representation (two's complement)
  let unsigned = n;
  if (n < 0n) {
    unsigned = (1n << 128n) + n;
  }

  const buf = Buffer.alloc(16);
  const lo = unsigned & 0xffff_ffff_ffff_ffffn;
  const hi = unsigned >> 64n;
  buf.writeBigUInt64LE(lo, 0);
  buf.writeBigUInt64LE(hi, 8);
  return buf;
}

/**
 * Encode a PublicKey (32 bytes)
 * Input: PublicKey or base58 string
 */
export function encPubkey(val: PublicKey | string): Buffer {
  const pk = typeof val === "string" ? new PublicKey(val) : val;
  return Buffer.from(pk.toBytes());
}

/**
 * Encode a boolean as u8 (0 = false, 1 = true)
 */
export function encBool(val: boolean): Buffer {
  return encU8(val ? 1 : 0);
}
