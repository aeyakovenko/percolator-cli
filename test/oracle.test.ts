/**
 * Oracle parsing/validation tests (TDD)
 *
 * Tests for parseChainlinkPrice() which extracts price data from
 * Chainlink aggregator account buffers with proper validation.
 */

import { parseChainlinkPrice } from "../src/solana/oracle.js";

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

console.log("Testing oracle parsing...\n");

// Helper: build a valid Chainlink aggregator buffer
// Chainlink layout: decimals at offset 138 (u8), answer at offset 216 (i64 LE)
function buildChainlinkBuffer(decimals: number, answer: bigint, size = 256): Buffer {
  const buf = Buffer.alloc(size);
  buf.writeUInt8(decimals, 138);
  buf.writeBigInt64LE(answer, 216);
  return buf;
}

// Valid oracle data
{
  const buf = buildChainlinkBuffer(8, 10012345678n); // $100.12345678
  const result = parseChainlinkPrice(buf);
  assert(result.decimals === 8, "decimals parsed correctly");
  assert(result.price === 10012345678n, "price parsed correctly");

  console.log("✓ parses valid oracle data");
}

// Different decimal values
{
  const buf6 = buildChainlinkBuffer(6, 100_000_000n);
  const r6 = parseChainlinkPrice(buf6);
  assert(r6.decimals === 6, "6 decimals");
  assert(r6.price === 100_000_000n, "price with 6 decimals");

  const buf0 = buildChainlinkBuffer(0, 42n);
  const r0 = parseChainlinkPrice(buf0);
  assert(r0.decimals === 0, "0 decimals");
  assert(r0.price === 42n, "price with 0 decimals");

  console.log("✓ handles various decimal values");
}

// Rejects buffer too small (< 224 bytes needed to read i64 at offset 216)
{
  assertThrows(
    () => parseChainlinkPrice(Buffer.alloc(100)),
    "too small",
    "rejects buffer < 224 bytes"
  );

  assertThrows(
    () => parseChainlinkPrice(Buffer.alloc(223)),
    "too small",
    "rejects buffer of exactly 223 bytes"
  );

  // 224 is the minimum (216 offset + 8 bytes for i64)
  const minimal = Buffer.alloc(224);
  minimal.writeUInt8(8, 138);
  minimal.writeBigInt64LE(1000n, 216);
  const minResult = parseChainlinkPrice(minimal);
  assert(minResult.price === 1000n, "accepts minimal 224-byte buffer");

  console.log("✓ rejects undersized buffers");
}

// Rejects zero-length buffer
{
  assertThrows(
    () => parseChainlinkPrice(Buffer.alloc(0)),
    "too small",
    "rejects empty buffer"
  );

  console.log("✓ rejects empty buffer");
}

// Rejects non-positive price
{
  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(8, 0n)),
    "non-positive",
    "rejects zero price"
  );

  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(8, -100n)),
    "non-positive",
    "rejects negative price"
  );

  console.log("✓ rejects non-positive prices");
}

// Rejects unreasonable decimals (> 18)
{
  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(19, 1000n)),
    "decimals",
    "rejects decimals > 18"
  );

  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(255, 1000n)),
    "decimals",
    "rejects decimals = 255"
  );

  // 18 should be fine
  const buf18 = buildChainlinkBuffer(18, 1000n);
  const r18 = parseChainlinkPrice(buf18);
  assert(r18.decimals === 18, "accepts 18 decimals");

  console.log("✓ rejects unreasonable decimals");
}

console.log("\n✅ All oracle tests passed!");
