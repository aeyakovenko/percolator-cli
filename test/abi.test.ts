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
  encodeInitMarket,
  encodeInitUser,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodeTradeNoCpi,
  encodeTradeCpi,
  encodeLiquidateAtOracle,
  encodeCloseAccount,
  encodeTopUpInsurance,
  encodeSetRiskThreshold,
  encodeUpdateAdmin,
  encodeInitLP,
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
  assert(IX_TAG.SetRiskThreshold === 11, "SetRiskThreshold tag");
  assert(IX_TAG.UpdateAdmin === 12, "UpdateAdmin tag");
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
// Note: fundingRate is now computed on-chain, no longer passed in instruction
{
  const data = encodeKeeperCrank({
    callerIdx: 1,
    allowPanic: true,
  });
  assert(data.length === 4, "KeeperCrank length");
  assert(data[0] === IX_TAG.KeeperCrank, "KeeperCrank tag byte");
  assertBuf(data.subarray(1, 3), [1, 0], "KeeperCrank callerIdx");
  assert(data[3] === 1, "KeeperCrank allowPanic");
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
  assert(data.length === 21, "TradeCpi length");
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

// Test SetRiskThreshold encoding (17 bytes: tag + u128)
{
  const data = encodeSetRiskThreshold({ newThreshold: "1000000000000" });
  assert(data.length === 17, "SetRiskThreshold length");
  assert(data[0] === IX_TAG.SetRiskThreshold, "SetRiskThreshold tag byte");
  console.log("✓ encodeSetRiskThreshold");
}

// Test UpdateAdmin encoding (33 bytes: tag + pubkey)
{
  const newAdmin = new PublicKey("11111111111111111111111111111111");
  const data = encodeUpdateAdmin({ newAdmin });
  assert(data.length === 33, "UpdateAdmin length");
  assert(data[0] === IX_TAG.UpdateAdmin, "UpdateAdmin tag byte");
  assert(
    data.subarray(1, 33).equals(Buffer.from(newAdmin.toBytes())),
    "UpdateAdmin pubkey"
  );
  console.log("✓ encodeUpdateAdmin");
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

// Test InitMarket encoding (256 bytes total)
// Layout: tag(1) + admin(32) + mint(32) + indexFeedId(32) +
//         maxStaleSecs(8) + confFilter(2) + invert(1) + unitScale(4) +
//         RiskParams(144)
{
  // Use keypair-generated valid pubkeys
  const admin = PublicKey.unique();
  const mint = PublicKey.unique();
  // Pyth feed ID for BTC/USD (example)
  const indexFeedId = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

  const data = encodeInitMarket({
    admin,
    collateralMint: mint,
    indexFeedId,
    maxStalenessSecs: "60",
    confFilterBps: 50,
    invert: 0,
    unitScale: 0,
    warmupPeriodSlots: "1000",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "10",
    maxAccounts: "1000",
    newAccountFee: "1000000",
    riskReductionThreshold: "1000000000",
    maintenanceFeePerSlot: "100",
    maxCrankStalenessSlots: "50",
    liquidationFeeBps: "100",
    liquidationFeeCap: "10000000",
    liquidationBufferBps: "50",
    minLiquidationAbs: "1000000",
  });
  assert(data.length === 256, `InitMarket length: expected 256, got ${data.length}`);
  assert(data[0] === IX_TAG.InitMarket, "InitMarket tag byte");
  console.log("✓ encodeInitMarket");
}

console.log("\n✅ All tests passed!");
