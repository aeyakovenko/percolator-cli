import { PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  readNonce,
  readMatCounter,
  parseAccount,
  parseEngine,
  parseParams,
  parseUsedIndices,
  isAccountUsed,
  layoutForDataLength,
  AccountKind,
} from "../src/solana/slab.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing slab parsing...\n");

const MAGIC = 0x504552434f4c4154n;
const HEADER_LEN = 136;
const CONFIG_OFFSET = HEADER_LEN;
const CONFIG_LEN = 384;
const ENGINE_OFF = 520;
const ENGINE_BITMAP_OFF = 1088;
const ENGINE_PARAMS_OFF = 32;
const PARAMS_MAX_ACCOUNTS_OFF = 24;
const ACCOUNT_SIZE = 416;
const MAX_ACCOUNTS = 64;

const layout = layoutForDataLength(29176);

// Create a mock slab buffer
function createMockSlab(): Buffer {
  const buf = Buffer.alloc(HEADER_LEN + CONFIG_LEN);

  // Header (136 bytes)
  buf.writeBigUInt64LE(MAGIC, 0);
  buf.writeUInt32LE(1, 8);
  buf.writeUInt8(255, 12);
  buf.writeUInt8(0b1100, 13);
  const adminBytes = Buffer.alloc(32);
  adminBytes[0] = 1;
  adminBytes.copy(buf, 16);
  buf.writeBigUInt64LE(42n, 48); // nonce
  buf.writeBigUInt64LE(12345n, 56); // matCounter
  const insuranceAuthority = Buffer.alloc(32);
  insuranceAuthority[0] = 0x44;
  insuranceAuthority.copy(buf, 72);
  const insuranceOperator = Buffer.alloc(32);
  insuranceOperator[0] = 0x45;
  insuranceOperator.copy(buf, 104);

  // MarketConfig (starting at offset 136)
  // Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
  //         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)

  let off = CONFIG_OFFSET;
  const mintBytes = Buffer.alloc(32);
  mintBytes[0] = 2;
  mintBytes.copy(buf, off); off += 32;
  const vaultBytes = Buffer.alloc(32);
  vaultBytes[0] = 3;
  vaultBytes.copy(buf, off); off += 32;
  const feedIdBytes = Buffer.alloc(32);
  feedIdBytes[0] = 5;
  feedIdBytes.copy(buf, off); off += 32;
  buf.writeBigUInt64LE(100n, off); off += 8;
  buf.writeUInt16LE(50, off); off += 2;
  buf.writeUInt8(254, off); off += 1;
  buf.writeUInt8(1, off); off += 1;
  buf.writeUInt32LE(0, off); off += 4;
  buf.writeBigUInt64LE(77n, off); off += 8;
  buf.writeBigUInt64LE(88n, off); off += 8;
  buf.writeBigInt64LE(-99n, off); off += 8;
  buf.writeBigInt64LE(-111n, off);

  return buf;
}

// Test parseHeader
{
  const slab = createMockSlab();
  const header = parseHeader(slab);

  assert(header.magic === MAGIC, "header magic");
  assert(header.version === 1, "header version");
  assert(header.bump === 255, "header bump");
  assert(header.flags === 0b1100, "header flags");
  assert(header.admin instanceof PublicKey, "header admin is PublicKey");
  assert(header.nonce === 42n, "header nonce");
  assert(header.matCounter === 12345n, "header matCounter");
  assert(header.insuranceAuthority instanceof PublicKey, "header insuranceAuthority is PublicKey");
  assert(header.insuranceOperator instanceof PublicKey, "header insuranceOperator is PublicKey");

  console.log("✓ parseHeader");
}

// Test parseConfig
{
  const slab = createMockSlab();
  const config = parseConfig(slab);

  assert(config.collateralMint instanceof PublicKey, "config mint is PublicKey");
  assert(config.vaultPubkey instanceof PublicKey, "config vault is PublicKey");
  assert(config.indexFeedId instanceof PublicKey, "config indexFeedId is PublicKey");
  assert(config.maxStalenessSecs === 100n, "config maxStalenessSecs");
  assert(config.confFilterBps === 50, "config confFilterBps");
  assert(config.vaultAuthorityBump === 254, "config vaultAuthorityBump");
  assert(config.invert === 1, "config invert");
  assert(config.unitScale === 0, "config unitScale");
  assert(config.fundingHorizonSlots === 77n, "config fundingHorizonSlots");
  assert(config.fundingKBps === 88n, "config fundingKBps");
  assert(config.fundingMaxPremiumBps === -99n, "config fundingMaxPremiumBps");
  assert(config.fundingMaxE9PerSlot === -111n, "config fundingMaxE9PerSlot");

  console.log("✓ parseConfig");
}

// Test readNonce
{
  const slab = createMockSlab();
  const nonce = readNonce(slab);
  assert(nonce === 42n, "readNonce");
  console.log("✓ readNonce");
}

// Test readMatCounter
{
  const slab = createMockSlab();
  const counter = readMatCounter(slab);
  assert(counter === 12345n, "readMatCounter");
  console.log("✓ readMatCounter");
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

// Account field offsets (SBF layout, 8-byte alignment for u128/i128)
const ACCT_CAPITAL_OFF = 0;
const ACCT_KIND_OFF = 16;
const ACCT_PNL_OFF = 24;
const ACCT_POSITION_BASIS_Q_OFF = 56;
const ACCT_LOSS_WEIGHT_OFF = 128;
const ACCT_B_SNAP_OFF = 144;
const ACCT_B_REM_OFF = 160;
const ACCT_B_EPOCH_SNAP_OFF = 176;
const ACCT_MATCHER_PROGRAM_OFF = 184;
const ACCT_OWNER_OFF = 248;

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
  const buf = Buffer.alloc(layout.slabLen);

  // Header (136 bytes)
  buf.writeBigUInt64LE(MAGIC, 0);  // magic
  buf.writeUInt32LE(1, 8);  // version
  buf.writeUInt8(255, 12);  // bump
  const adminBytes = Buffer.alloc(32);
  adminBytes[0] = 1;
  adminBytes.copy(buf, 16);
  buf.writeBigUInt64LE(42n, 48);  // nonce
  buf.writeBigUInt64LE(12345n, 56);  // matCounter

  // MarketConfig - simplified (starts at offset 136)
  const mintBytes = Buffer.alloc(32);
  mintBytes[0] = 2;
  mintBytes.copy(buf, CONFIG_OFFSET);

  // RiskParams
  const paramsBase = ENGINE_OFF + ENGINE_PARAMS_OFF;
  buf.writeBigUInt64LE(BigInt(MAX_ACCOUNTS), paramsBase + PARAMS_MAX_ACCOUNTS_OFF);

  // Set bitmap - mark accounts 0 and 1 as used
  const bitmapOffset = ENGINE_OFF + ENGINE_BITMAP_OFF;
  buf.writeBigUInt64LE(3n, bitmapOffset);  // bits 0 and 1 set
  buf.writeUInt16LE(2, ENGINE_OFF + layout.engineNumUsedOff);
  buf.writeUInt16LE(7, ENGINE_OFF + layout.engineFreeHeadOff);

  // Create account at index 0 (LP)
  const acc0Base = ENGINE_OFF + layout.engineAccountsOff + 0 * ACCOUNT_SIZE;
  writeU128LE(buf, acc0Base + ACCT_CAPITAL_OFF, 1000000000n);  // capital: 1 SOL
  buf.writeUInt8(1, acc0Base + ACCT_KIND_OFF);  // kind: LP (1)
  writeI128LE(buf, acc0Base + ACCT_PNL_OFF, 0n);  // pnl: 0
  writeI128LE(buf, acc0Base + ACCT_POSITION_BASIS_Q_OFF, 0n);  // position: 0
  writeU128LE(buf, acc0Base + ACCT_LOSS_WEIGHT_OFF, 11n);
  writeU128LE(buf, acc0Base + ACCT_B_SNAP_OFF, 12n);
  writeU128LE(buf, acc0Base + ACCT_B_REM_OFF, 13n);
  buf.writeBigUInt64LE(14n, acc0Base + ACCT_B_EPOCH_SNAP_OFF);
  // Set matcher_program (non-zero for LP)
  const matcherProg = Buffer.alloc(32);
  matcherProg[0] = 0xAA;
  matcherProg.copy(buf, acc0Base + ACCT_MATCHER_PROGRAM_OFF);
  // Set owner
  const owner0 = Buffer.alloc(32);
  owner0[0] = 0x11;
  owner0.copy(buf, acc0Base + ACCT_OWNER_OFF);

  // Create account at index 1 (User)
  const acc1Base = ENGINE_OFF + layout.engineAccountsOff + 1 * ACCOUNT_SIZE;
  writeU128LE(buf, acc1Base + ACCT_CAPITAL_OFF, 500000000n);  // capital: 0.5 SOL
  buf.writeUInt8(0, acc1Base + ACCT_KIND_OFF);  // kind: User (0)
  writeI128LE(buf, acc1Base + ACCT_PNL_OFF, -100000n);  // pnl: -0.0001 SOL
  writeI128LE(buf, acc1Base + ACCT_POSITION_BASIS_Q_OFF, 1000000n);  // position: 1M units
  writeU128LE(buf, acc1Base + ACCT_LOSS_WEIGHT_OFF, 21n);
  writeU128LE(buf, acc1Base + ACCT_B_SNAP_OFF, 22n);
  writeU128LE(buf, acc1Base + ACCT_B_REM_OFF, 23n);
  buf.writeBigUInt64LE(24n, acc1Base + ACCT_B_EPOCH_SNAP_OFF);
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
  assert(acc0.capital === 1000000000n, "account 0 capital");

  // Test User account (index 1)
  const acc1 = parseAccount(slab, 1);
  assert(acc1.kind === AccountKind.User, "account 1 should be User");
  assert(acc1.capital === 500000000n, "account 1 capital");

  console.log("✓ parseAccount kind field (LP vs User)");
}

// Test account fields
{
  const slab = createFullMockSlab();
  const acc1 = parseAccount(slab, 1);

  assert(acc1.positionBasisQ === 1000000n, "account position basis q");
  assert(acc1.pnl === -100000n, "account pnl (negative)");
  assert(acc1.lossWeight === 21n, "account lossWeight");
  assert(acc1.bSnap === 22n, "account bSnap");
  assert(acc1.bRem === 23n, "account bRem");
  assert(acc1.bEpochSnap === 24n, "account bEpochSnap");
  assert(acc1.owner instanceof PublicKey, "account owner is PublicKey");

  console.log("✓ parseAccount fields (position, pnl, owner)");
}

// Test RiskParams and RiskEngine layout-derived fields
{
  const slab = createFullMockSlab();
  const params = parseParams(slab);
  const engine = parseEngine(slab);

  assert(params.maxAccounts === BigInt(MAX_ACCOUNTS), "params maxAccounts");
  assert(engine.numUsedAccounts === 2, "engine numUsedAccounts");
  assert(engine.freeHead === 7, "engine freeHead");

  console.log("✓ parseParams and parseEngine layout fields");
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
