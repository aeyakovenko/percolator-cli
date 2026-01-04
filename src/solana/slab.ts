import { Connection, PublicKey } from "@solana/web3.js";

// Constants from Rust
const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
const HEADER_LEN = 64;
const CONFIG_OFFSET = HEADER_LEN;
const RESERVED_OFF = 48;

/**
 * Slab header (64 bytes)
 */
export interface SlabHeader {
  magic: bigint;
  version: number;
  bump: number;
  admin: PublicKey;
  nonce: bigint;
  lastThrUpdateSlot: bigint;
}

/**
 * Market config (90 bytes, starts at offset 64)
 */
export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  collateralOracle: PublicKey;
  indexOracle: PublicKey;
  maxStalenessSlots: bigint;
  confFilterBps: number;
  vaultAuthorityBump: number;
}

/**
 * Fetch raw slab account data.
 */
export async function fetchSlab(
  connection: Connection,
  slabPubkey: PublicKey
): Promise<Buffer> {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) {
    throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  }
  return Buffer.from(info.data);
}

/**
 * Parse slab header (first 64 bytes).
 */
export function parseHeader(data: Buffer): SlabHeader {
  if (data.length < HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${HEADER_LEN}`);
  }

  const magic = data.readBigUInt64LE(0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid slab magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }

  const version = data.readUInt32LE(8);
  const bump = data.readUInt8(12);
  const admin = new PublicKey(data.subarray(16, 48));

  // Reserved field: nonce at [0..8], lastThrUpdateSlot at [8..16]
  const nonce = data.readBigUInt64LE(RESERVED_OFF);
  const lastThrUpdateSlot = data.readBigUInt64LE(RESERVED_OFF + 8);

  return {
    magic,
    version,
    bump,
    admin,
    nonce,
    lastThrUpdateSlot,
  };
}

/**
 * Parse market config (starts at byte 64, 90 bytes).
 */
export function parseConfig(data: Buffer): MarketConfig {
  const minLen = CONFIG_OFFSET + 90;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }

  let off = CONFIG_OFFSET;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const collateralOracle = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const indexOracle = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const maxStalenessSlots = data.readBigUInt64LE(off);
  off += 8;

  const confFilterBps = data.readUInt16LE(off);
  off += 2;

  const vaultAuthorityBump = data.readUInt8(off);

  return {
    collateralMint,
    vaultPubkey,
    collateralOracle,
    indexOracle,
    maxStalenessSlots,
    confFilterBps,
    vaultAuthorityBump,
  };
}

/**
 * Read nonce from slab header reserved field.
 */
export function readNonce(data: Buffer): bigint {
  if (data.length < RESERVED_OFF + 8) {
    throw new Error("Slab data too short for nonce");
  }
  return data.readBigUInt64LE(RESERVED_OFF);
}

/**
 * Read last threshold update slot from slab header reserved field.
 */
export function readLastThrUpdateSlot(data: Buffer): bigint {
  if (data.length < RESERVED_OFF + 16) {
    throw new Error("Slab data too short for lastThrUpdateSlot");
  }
  return data.readBigUInt64LE(RESERVED_OFF + 8);
}
