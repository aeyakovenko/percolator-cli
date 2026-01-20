import { PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  readNonce,
  readLastThrUpdateSlot,
  parseAccount,
  parseEngine,
  parseParams,
  parseUsedIndices,
  isAccountUsed,
  AccountKind,
} from "../src/solana/slab.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing slab parsing...\n");

// Create a mock slab buffer
function createMockSlab(): Buffer {
  const buf = Buffer.alloc(400);  // HEADER_LEN(72) + CONFIG_LEN(256) = 328 minimum

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

  // MarketConfig (starting at offset 72)
  // Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
  //         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)

  // collateralMint: 32 bytes at offset 72
  const mintBytes = Buffer.alloc(32);
  mintBytes[0] = 2;
  mintBytes.copy(buf, 72);
  // vaultPubkey: 32 bytes at offset 104
  const vaultBytes = Buffer.alloc(32);
  vaultBytes[0] = 3;
  vaultBytes.copy(buf, 104);
  // index_feed_id: 32 bytes at offset 136
  const feedIdBytes = Buffer.alloc(32);
  feedIdBytes[0] = 5;
  feedIdBytes.copy(buf, 136);
  // maxStalenessSlots: u64 at offset 168
  buf.writeBigUInt64LE(100n, 168);
  // confFilterBps: u16 at offset 176
  buf.writeUInt16LE(50, 176);
  // vaultAuthorityBump: u8 at offset 178
  buf.writeUInt8(254, 178);
  // invert: u8 at offset 179
  buf.writeUInt8(1, 179);
  // unitScale: u32 at offset 180
  buf.writeUInt32LE(0, 180);

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
  assert(config.indexFeedId instanceof PublicKey, "config indexFeedId is PublicKey");
  assert(config.maxStalenessSlots === 100n, "config maxStalenessSlots");
  assert(config.confFilterBps === 50, "config confFilterBps");
  assert(config.vaultAuthorityBump === 254, "config vaultAuthorityBump");
  assert(config.invert === 1, "config invert");
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

console.log("\n✅ All basic slab tests passed!");

// =============================================================================
// Account Parsing Tests
// =============================================================================

console.log("\nTesting account parsing...\n");

// Constants from slab.ts for testing
const ENGINE_OFF = 376;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;
const ENGINE_BITMAP_OFF = 86520;

// Account field offsets
const ACCT_ACCOUNT_ID_OFF = 0;
const ACCT_CAPITAL_OFF = 8;
const ACCT_KIND_OFF = 24;
const ACCT_PNL_OFF = 32;
const ACCT_POSITION_SIZE_OFF = 80;
const ACCT_ENTRY_PRICE_OFF = 96;
const ACCT_MATCHER_PROGRAM_OFF = 120;
const ACCT_MATCHER_CONTEXT_OFF = 152;
const ACCT_OWNER_OFF = 184;

// Helper to write u128 as two u64s
function writeU128LE(buf: Buffer, offset: number, value: bigint): void {
  const lo = value & BigInt("0xFFFFFFFFFFFFFFFF");
  const hi = (value >> 64n) & BigInt("0xFFFFFFFFFFFFFFFF");
  buf.writeBigUInt64LE(lo, offset);
  buf.writeBigUInt64LE(hi, offset + 8);
}

// Helper to write i128 as two u64s
function writeI128LE(buf: Buffer, offset: number, value: bigint): void {
  if (value < 0n) {
    value = (1n << 128n) + value;  // Convert to unsigned
  }
  writeU128LE(buf, offset, value);
}

// Create a full mock slab with accounts
function createFullMockSlab(): Buffer {
  // Need enough space for header + config + engine + bitmap + accounts
  const minSize = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + ACCOUNT_SIZE * 4;
  const buf = Buffer.alloc(minSize);

  // Header (72 bytes)
  buf.writeBigUInt64LE(0x504552434f4c4154n, 0);  // magic
  buf.writeUInt32LE(1, 8);  // version
  buf.writeUInt8(255, 12);  // bump
  const adminBytes = Buffer.alloc(32);
  adminBytes[0] = 1;
  adminBytes.copy(buf, 16);
  buf.writeBigUInt64LE(42n, 48);  // nonce
  buf.writeBigUInt64LE(12345n, 56);  // lastThrUpdateSlot

  // MarketConfig - simplified (starts at offset 72)
  const mintBytes = Buffer.alloc(32);
  mintBytes[0] = 2;
  mintBytes.copy(buf, 72);

  // Set bitmap - mark accounts 0 and 1 as used
  const bitmapOffset = ENGINE_OFF + ENGINE_BITMAP_OFF;
  buf.writeBigUInt64LE(3n, bitmapOffset);  // bits 0 and 1 set

  // Create account at index 0 (LP)
  const acc0Base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 0 * ACCOUNT_SIZE;
  buf.writeBigUInt64LE(100n, acc0Base + ACCT_ACCOUNT_ID_OFF);  // accountId
  writeU128LE(buf, acc0Base + ACCT_CAPITAL_OFF, 1000000000n);  // capital: 1 SOL
  buf.writeUInt8(1, acc0Base + ACCT_KIND_OFF);  // kind: LP (1)
  writeI128LE(buf, acc0Base + ACCT_PNL_OFF, 0n);  // pnl: 0
  writeI128LE(buf, acc0Base + ACCT_POSITION_SIZE_OFF, 0n);  // position: 0
  buf.writeBigUInt64LE(150000000n, acc0Base + ACCT_ENTRY_PRICE_OFF);  // entry price: $150
  // Set matcher_program (non-zero for LP)
  const matcherProg = Buffer.alloc(32);
  matcherProg[0] = 0xAA;
  matcherProg.copy(buf, acc0Base + ACCT_MATCHER_PROGRAM_OFF);
  // Set owner
  const owner0 = Buffer.alloc(32);
  owner0[0] = 0x11;
  owner0.copy(buf, acc0Base + ACCT_OWNER_OFF);

  // Create account at index 1 (User)
  const acc1Base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 1 * ACCOUNT_SIZE;
  buf.writeBigUInt64LE(101n, acc1Base + ACCT_ACCOUNT_ID_OFF);  // accountId
  writeU128LE(buf, acc1Base + ACCT_CAPITAL_OFF, 500000000n);  // capital: 0.5 SOL
  buf.writeUInt8(0, acc1Base + ACCT_KIND_OFF);  // kind: User (0)
  writeI128LE(buf, acc1Base + ACCT_PNL_OFF, -100000n);  // pnl: -0.0001 SOL
  writeI128LE(buf, acc1Base + ACCT_POSITION_SIZE_OFF, 1000000n);  // position: 1M units
  buf.writeBigUInt64LE(145000000n, acc1Base + ACCT_ENTRY_PRICE_OFF);  // entry price: $145
  // matcher_program stays zero (User accounts don't have matchers)
  // Set owner
  const owner1 = Buffer.alloc(32);
  owner1[0] = 0x22;
  owner1.copy(buf, acc1Base + ACCT_OWNER_OFF);

  return buf;
}

// Test account kind parsing
{
  const slab = createFullMockSlab();

  // Test LP account (index 0)
  const acc0 = parseAccount(slab, 0);
  assert(acc0.kind === AccountKind.LP, "account 0 should be LP");
  assert(acc0.accountId === 100n, "account 0 accountId");
  assert(acc0.capital === 1000000000n, "account 0 capital");

  // Test User account (index 1)
  const acc1 = parseAccount(slab, 1);
  assert(acc1.kind === AccountKind.User, "account 1 should be User");
  assert(acc1.accountId === 101n, "account 1 accountId");
  assert(acc1.capital === 500000000n, "account 1 capital");

  console.log("✓ parseAccount kind field (LP vs User)");
}

// Test account fields
{
  const slab = createFullMockSlab();
  const acc1 = parseAccount(slab, 1);

  assert(acc1.positionSize === 1000000n, "account position size");
  assert(acc1.entryPrice === 145000000n, "account entry price");
  assert(acc1.pnl === -100000n, "account pnl (negative)");
  assert(acc1.owner instanceof PublicKey, "account owner is PublicKey");

  console.log("✓ parseAccount fields (position, entry price, pnl, owner)");
}

// Test bitmap parsing
{
  const slab = createFullMockSlab();
  const indices = parseUsedIndices(slab);

  assert(indices.length === 2, "should have 2 used indices");
  assert(indices.includes(0), "should include index 0");
  assert(indices.includes(1), "should include index 1");
  assert(!indices.includes(2), "should not include index 2");

  console.log("✓ parseUsedIndices (bitmap parsing)");
}

// Test isAccountUsed
{
  const slab = createFullMockSlab();

  assert(isAccountUsed(slab, 0) === true, "account 0 should be used");
  assert(isAccountUsed(slab, 1) === true, "account 1 should be used");
  assert(isAccountUsed(slab, 2) === false, "account 2 should not be used");
  assert(isAccountUsed(slab, 64) === false, "account 64 should not be used");

  console.log("✓ isAccountUsed");
}

// Test account index bounds
{
  const slab = createFullMockSlab();

  let threw = false;
  try {
    parseAccount(slab, 10000);  // Way out of bounds
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("out of range"), "error mentions out of range");
  }
  assert(threw, "parseAccount throws on out of bounds index");

  console.log("✓ parseAccount rejects out of bounds index");
}

// Test negative index
{
  const slab = createFullMockSlab();

  let threw = false;
  try {
    parseAccount(slab, -1);
  } catch (e) {
    threw = true;
  }
  assert(threw, "parseAccount throws on negative index");

  console.log("✓ parseAccount rejects negative index");
}

console.log("\n✅ All account tests passed!");

console.log("\n✅ All slab tests passed!");
