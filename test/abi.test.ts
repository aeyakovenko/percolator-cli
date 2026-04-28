import { PublicKey } from "@solana/web3.js";
import {
  encU8,
  encU16,
  encU64,
  encI64,
  encU128,
  encI128,
  encPubkey,
} from "../src/abi/encode.js";
import {
  encodeInitUser,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodeTradeNoCpi,
  encodeTradeCpi,
  encodeLiquidateAtOracle,
  encodeCloseAccount,
  encodeTopUpInsurance,
  encodeInitLP,
  encodeAdminForceCloseAccount,
  encodeWithdrawInsuranceLimited,
  IX_TAG,
} from "../src/abi/instructions.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertBuf(actual: Buffer, expected: number[], msg: string): void {
  const exp = Buffer.from(expected);
  if (!actual.equals(exp)) {
    throw new Error(
      `FAIL: ${msg}\n  expected: [${[...exp].join(", ")}]\n  actual:   [${[...actual].join(", ")}]`
    );
  }
}

console.log("Testing encode functions...\n");

// Test encU8
{
  assertBuf(encU8(0), [0], "encU8(0)");
  assertBuf(encU8(255), [255], "encU8(255)");
  assertBuf(encU8(127), [127], "encU8(127)");
  console.log("✓ encU8");
}

// Test encU16
{
  assertBuf(encU16(0), [0, 0], "encU16(0)");
  assertBuf(encU16(1), [1, 0], "encU16(1)");
  assertBuf(encU16(256), [0, 1], "encU16(256)");
  assertBuf(encU16(0xabcd), [0xcd, 0xab], "encU16(0xabcd)");
  assertBuf(encU16(65535), [255, 255], "encU16(65535)");
  console.log("✓ encU16");
}

// Test encU64
{
  assertBuf(encU64(0n), [0, 0, 0, 0, 0, 0, 0, 0], "encU64(0)");
  assertBuf(encU64(1n), [1, 0, 0, 0, 0, 0, 0, 0], "encU64(1)");
  assertBuf(encU64(256n), [0, 1, 0, 0, 0, 0, 0, 0], "encU64(256)");
  assertBuf(encU64("1000000"), [64, 66, 15, 0, 0, 0, 0, 0], "encU64(1000000)");
  assertBuf(
    encU64(0xffff_ffff_ffff_ffffn),
    [255, 255, 255, 255, 255, 255, 255, 255],
    "encU64(max)"
  );
  console.log("✓ encU64");
}

// Test encI64
{
  assertBuf(encI64(0n), [0, 0, 0, 0, 0, 0, 0, 0], "encI64(0)");
  assertBuf(encI64(1n), [1, 0, 0, 0, 0, 0, 0, 0], "encI64(1)");
  assertBuf(encI64(-1n), [255, 255, 255, 255, 255, 255, 255, 255], "encI64(-1)");
  assertBuf(encI64(-2n), [254, 255, 255, 255, 255, 255, 255, 255], "encI64(-2)");
  assertBuf(encI64("-100"), [156, 255, 255, 255, 255, 255, 255, 255], "encI64(-100)");
  console.log("✓ encI64");
}

// Test encU128
{
  assertBuf(
    encU128(0n),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "encU128(0)"
  );
  assertBuf(
    encU128(1n),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "encU128(1)"
  );
  // 2^64 should have lo=0, hi=1
  assertBuf(
    encU128(1n << 64n),
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    "encU128(2^64)"
  );
  // Large value: 0x0102030405060708_090a0b0c0d0e0f10
  const large = 0x0102030405060708_090a0b0c0d0e0f10n;
  assertBuf(
    encU128(large),
    [0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01],
    "encU128(large)"
  );
  console.log("✓ encU128");
}

// Test encI128
{
  assertBuf(
    encI128(0n),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "encI128(0)"
  );
  assertBuf(
    encI128(1n),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "encI128(1)"
  );
  assertBuf(
    encI128(-1n),
    [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    "encI128(-1)"
  );
  assertBuf(
    encI128(-2n),
    [254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    "encI128(-2)"
  );
  // Test a positive value that fits in i128
  assertBuf(
    encI128(1000000n),
    [64, 66, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "encI128(1000000)"
  );
  // Test negative large value: -1000000
  assertBuf(
    encI128(-1000000n),
    [192, 189, 240, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    "encI128(-1000000)"
  );
  console.log("✓ encI128");
}

// Test encPubkey
{
  const pk = new PublicKey("11111111111111111111111111111111");
  const buf = encPubkey(pk);
  assert(buf.length === 32, "encPubkey length");
  assert(buf.equals(Buffer.from(pk.toBytes())), "encPubkey value");
  console.log("✓ encPubkey");
}

console.log("\nTesting instruction encoders...\n");

// Test instruction tags
{
  assert(IX_TAG.InitMarket === 0, "InitMarket tag");
  assert(IX_TAG.InitUser === 1, "InitUser tag");
  assert(IX_TAG.InitLP === 2, "InitLP tag");
  assert(IX_TAG.DepositCollateral === 3, "DepositCollateral tag");
  assert(IX_TAG.WithdrawCollateral === 4, "WithdrawCollateral tag");
  assert(IX_TAG.KeeperCrank === 5, "KeeperCrank tag");
  assert(IX_TAG.TradeNoCpi === 6, "TradeNoCpi tag");
  assert(IX_TAG.LiquidateAtOracle === 7, "LiquidateAtOracle tag");
  assert(IX_TAG.CloseAccount === 8, "CloseAccount tag");
  assert(IX_TAG.TopUpInsurance === 9, "TopUpInsurance tag");
  assert(IX_TAG.TradeCpi === 10, "TradeCpi tag");
  console.log("✓ IX_TAG values");
}

// Test InitUser encoding (9 bytes: tag + u64)
{
  const data = encodeInitUser({ feePayment: "1000000" });
  assert(data.length === 9, "InitUser length");
  assert(data[0] === IX_TAG.InitUser, "InitUser tag byte");
  // fee = 1000000 = 0x0F4240 LE
  assertBuf(data.subarray(1, 9), [64, 66, 15, 0, 0, 0, 0, 0], "InitUser fee");
  console.log("✓ encodeInitUser");
}

// Test DepositCollateral encoding (11 bytes: tag + u16 + u64)
{
  const data = encodeDepositCollateral({ userIdx: 5, amount: "1000000" });
  assert(data.length === 11, "DepositCollateral length");
  assert(data[0] === IX_TAG.DepositCollateral, "DepositCollateral tag byte");
  assertBuf(data.subarray(1, 3), [5, 0], "DepositCollateral userIdx");
  assertBuf(data.subarray(3, 11), [64, 66, 15, 0, 0, 0, 0, 0], "DepositCollateral amount");
  console.log("✓ encodeDepositCollateral");
}

// Test WithdrawCollateral encoding (11 bytes: tag + u16 + u64)
{
  const data = encodeWithdrawCollateral({ userIdx: 10, amount: "500000" });
  assert(data.length === 11, "WithdrawCollateral length");
  assert(data[0] === IX_TAG.WithdrawCollateral, "WithdrawCollateral tag byte");
  assertBuf(data.subarray(1, 3), [10, 0], "WithdrawCollateral userIdx");
  console.log("✓ encodeWithdrawCollateral");
}

// Test KeeperCrank encoding (4 bytes: tag + u16 + u8)
// format_version is 1 (v12.17+) (legacy bare u16 indices)
{
  const data = encodeKeeperCrank({
    callerIdx: 1,
  });
  assert(data.length === 4, "KeeperCrank length");
  assert(data[0] === IX_TAG.KeeperCrank, "KeeperCrank tag byte");
  assertBuf(data.subarray(1, 3), [1, 0], "KeeperCrank callerIdx");
  assert(data[3] === 1, "KeeperCrank format_version=1");
  console.log("✓ encodeKeeperCrank");
}

// Test TradeNoCpi encoding (21 bytes: tag + u16 + u16 + i128)
{
  const data = encodeTradeNoCpi({ lpIdx: 0, userIdx: 1, size: "1000000" });
  assert(data.length === 21, "TradeNoCpi length");
  assert(data[0] === IX_TAG.TradeNoCpi, "TradeNoCpi tag byte");
  assertBuf(data.subarray(1, 3), [0, 0], "TradeNoCpi lpIdx");
  assertBuf(data.subarray(3, 5), [1, 0], "TradeNoCpi userIdx");
  console.log("✓ encodeTradeNoCpi");
}

// Test TradeNoCpi with negative size
{
  const data = encodeTradeNoCpi({ lpIdx: 0, userIdx: 1, size: "-1000000" });
  assert(data.length === 21, "TradeNoCpi negative length");
  // Verify the i128 encoding of -1000000
  const sizeBytes = data.subarray(5, 21);
  assertBuf(
    sizeBytes,
    [192, 189, 240, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    "TradeNoCpi negative size"
  );
  console.log("✓ encodeTradeNoCpi (negative size)");
}

// Test TradeCpi encoding (21 bytes: tag + u16 + u16 + i128)
{
  const data = encodeTradeCpi({ lpIdx: 2, userIdx: 3, size: "-500" });
  assert(data.length === 29, "TradeCpi length");
  assert(data[0] === IX_TAG.TradeCpi, "TradeCpi tag byte");
  assertBuf(data.subarray(1, 3), [2, 0], "TradeCpi lpIdx");
  assertBuf(data.subarray(3, 5), [3, 0], "TradeCpi userIdx");
  console.log("✓ encodeTradeCpi");
}

// Test LiquidateAtOracle encoding (3 bytes: tag + u16)
{
  const data = encodeLiquidateAtOracle({ targetIdx: 42 });
  assert(data.length === 3, "LiquidateAtOracle length");
  assert(data[0] === IX_TAG.LiquidateAtOracle, "LiquidateAtOracle tag byte");
  assertBuf(data.subarray(1, 3), [42, 0], "LiquidateAtOracle targetIdx");
  console.log("✓ encodeLiquidateAtOracle");
}

// Test CloseAccount encoding (3 bytes: tag + u16)
{
  const data = encodeCloseAccount({ userIdx: 100 });
  assert(data.length === 3, "CloseAccount length");
  assert(data[0] === IX_TAG.CloseAccount, "CloseAccount tag byte");
  assertBuf(data.subarray(1, 3), [100, 0], "CloseAccount userIdx");
  console.log("✓ encodeCloseAccount");
}

// Test TopUpInsurance encoding (9 bytes: tag + u64)
{
  const data = encodeTopUpInsurance({ amount: "5000000" });
  assert(data.length === 9, "TopUpInsurance length");
  assert(data[0] === IX_TAG.TopUpInsurance, "TopUpInsurance tag byte");
  console.log("✓ encodeTopUpInsurance");
}

// Test InitLP encoding (73 bytes: tag + pubkey + pubkey + u64)
{
  // Use keypair-generated valid pubkeys
  const matcherProg = PublicKey.unique();
  const matcherCtx = PublicKey.unique();
  const data = encodeInitLP({
    matcherProgram: matcherProg,
    matcherContext: matcherCtx,
    feePayment: "1000000",
  });
  assert(data.length === 73, "InitLP length");
  assert(data[0] === IX_TAG.InitLP, "InitLP tag byte");
  console.log("✓ encodeInitLP");
}

// NOTE: encodeInitMarket test removed — the previous test args were
// pinned to a pre-v12.21 InitMarketArgs shape (e.g. maxMaintenanceFeePerSlot,
// maxInsuranceFloor, warmupPeriodSlots, liquidationBufferBps, minInitialDeposit),
// none of which exist on the current interface. The current shape requires
// hMin / hMax / resolvePriceDeviationBps / maxPriceMoveBpsPerSlot and the
// extended-tail funding/insurance fields. A new test against the v12.21+
// shape can be added in a follow-up that also pins the expected length.

// Test AdminForceCloseAccount encoding (3 bytes: tag + u16)
{
  const data = encodeAdminForceCloseAccount({ userIdx: 7 });
  assert(data.length === 3, "AdminForceCloseAccount length");
  assert(data[0] === IX_TAG.AdminForceCloseAccount, "AdminForceCloseAccount tag byte");
  assertBuf(data.subarray(1, 3), [7, 0], "AdminForceCloseAccount userIdx");
  console.log("✓ encodeAdminForceCloseAccount");
}

// Test WithdrawInsuranceLimited encoding (9 bytes: tag + u64)
{
  const data = encodeWithdrawInsuranceLimited({ amount: "5000" });
  assert(data.length === 9, "WithdrawInsuranceLimited length");
  assert(data[0] === IX_TAG.WithdrawInsuranceLimited, "WithdrawInsuranceLimited tag byte");
  console.log("✓ encodeWithdrawInsuranceLimited");
}

console.log("\n✅ All tests passed!");
