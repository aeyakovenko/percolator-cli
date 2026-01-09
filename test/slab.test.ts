import { PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  readNonce,
  readLastThrUpdateSlot,
} from "../src/solana/slab.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing slab parsing...\n");

// Create a mock slab buffer
function createMockSlab(): Buffer {
  const buf = Buffer.alloc(300);

  // Header (72 bytes)
  // magic: "PERCOLAT" = 0x504552434f4c4154
  buf.writeBigUInt64LE(0x504552434f4c4154n, 0);
  // version: 1
  buf.writeUInt32LE(1, 8);
  // bump: 255
  buf.writeUInt8(255, 12);
  // padding: 3 bytes (skip)
  // admin: 32 bytes (use zeros, which is valid as a pubkey)
  const adminBytes = Buffer.alloc(32);
  adminBytes[0] = 1; // Make it non-zero
  adminBytes.copy(buf, 16);
  // reserved: nonce at [48..56], lastThrUpdateSlot at [56..64], then 8 more bytes padding to 72
  buf.writeBigUInt64LE(42n, 48); // nonce = 42
  buf.writeBigUInt64LE(12345n, 56); // lastThrUpdateSlot = 12345

  // MarketConfig (144 bytes starting at offset 72)
  // Layout: collateral_mint(32) + vault_pubkey(32) + _reserved(32) + index_feed_id(32)
  //         + max_staleness_secs(8) + conf_filter_bps(2) + bump(1) + invert(1) + unit_scale(4)

  // collateralMint: 32 bytes at offset 72
  const mintBytes = Buffer.alloc(32);
  mintBytes[0] = 2;
  mintBytes.copy(buf, 72);
  // vaultPubkey: 32 bytes at offset 104
  const vaultBytes = Buffer.alloc(32);
  vaultBytes[0] = 3;
  vaultBytes.copy(buf, 104);
  // _reserved (collateralOracle): 32 bytes at offset 136
  const reservedBytes = Buffer.alloc(32);
  reservedBytes[0] = 4;
  reservedBytes.copy(buf, 136);
  // index_feed_id (indexOracle): 32 bytes at offset 168
  const feedIdBytes = Buffer.alloc(32);
  feedIdBytes[0] = 5;
  feedIdBytes.copy(buf, 168);
  // maxStalenessSlots: u64 at offset 200
  buf.writeBigUInt64LE(100n, 200);
  // confFilterBps: u16 at offset 208
  buf.writeUInt16LE(50, 208);
  // vaultAuthorityBump: u8 at offset 210
  buf.writeUInt8(254, 210);
  // invert: u8 at offset 211
  buf.writeUInt8(0, 211);
  // unitScale: u32 at offset 212
  buf.writeUInt32LE(0, 212);

  return buf;
}

// Test parseHeader
{
  const slab = createMockSlab();
  const header = parseHeader(slab);

  assert(header.magic === 0x504552434f4c4154n, "header magic");
  assert(header.version === 1, "header version");
  assert(header.bump === 255, "header bump");
  assert(header.admin instanceof PublicKey, "header admin is PublicKey");
  assert(header.nonce === 42n, "header nonce");
  assert(header.lastThrUpdateSlot === 12345n, "header lastThrUpdateSlot");

  console.log("✓ parseHeader");
}

// Test parseConfig
{
  const slab = createMockSlab();
  const config = parseConfig(slab);

  assert(config.collateralMint instanceof PublicKey, "config mint is PublicKey");
  assert(config.vaultPubkey instanceof PublicKey, "config vault is PublicKey");
  // Note: On deployed devnet, oracle pubkeys are not stored in MarketConfig
  // They return PublicKey.default
  assert(config.collateralOracle instanceof PublicKey, "config colOracle is PublicKey");
  assert(config.indexOracle instanceof PublicKey, "config idxOracle is PublicKey");
  assert(config.maxStalenessSlots === 100n, "config maxStalenessSlots");
  assert(config.confFilterBps === 50, "config confFilterBps");
  assert(config.vaultAuthorityBump === 254, "config vaultAuthorityBump");
  assert(config.invert === 0, "config invert");
  assert(config.unitScale === 0, "config unitScale");

  console.log("✓ parseConfig");
}

// Test readNonce
{
  const slab = createMockSlab();
  const nonce = readNonce(slab);
  assert(nonce === 42n, "readNonce");
  console.log("✓ readNonce");
}

// Test readLastThrUpdateSlot
{
  const slab = createMockSlab();
  const slot = readLastThrUpdateSlot(slab);
  assert(slot === 12345n, "readLastThrUpdateSlot");
  console.log("✓ readLastThrUpdateSlot");
}

// Test error on invalid magic
{
  const slab = createMockSlab();
  slab.writeBigUInt64LE(0n, 0); // Invalid magic

  let threw = false;
  try {
    parseHeader(slab);
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("Invalid slab magic"),
      "error message mentions invalid magic"
    );
  }
  assert(threw, "parseHeader throws on invalid magic");
  console.log("✓ parseHeader rejects invalid magic");
}

// Test error on short buffer
{
  const shortBuf = Buffer.alloc(32);

  let threw = false;
  try {
    parseHeader(shortBuf);
  } catch (e) {
    threw = true;
  }
  assert(threw, "parseHeader throws on short buffer");
  console.log("✓ parseHeader rejects short buffer");
}

console.log("\n✅ All slab tests passed!");
