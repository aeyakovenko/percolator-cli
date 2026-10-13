import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  DEFAULT_MAGICBLOCK_MAX_AGE_SECS,
  MAGICBLOCK_DEMO_FEEDS,
  MAGICBLOCK_ORACLE_IDENTITY,
  MAGICBLOCK_PRICE_PROGRAM_ID,
  MAGICBLOCK_STORED_WRITE_AUTHORITY,
  MagicBlockPriceConfigurationError,
  MagicBlockPriceIntegrityError,
  MagicBlockPriceUnavailableError,
  parseMagicBlockDemoPriceAccount,
  readMagicBlockDemoPrices,
  requireMagicBlockDemoConfiguration,
} from "./magicblock-demo-prices.ts";

const NOW = 1_800_000_000;
const configuration = requireMagicBlockDemoConfiguration({});

function priceAccount(args: {
  feedPosition?: number;
  owner?: PublicKey;
  writer?: PublicKey;
  discriminator?: Buffer;
  verification?: number;
  embeddedFeed?: PublicKey;
  price?: bigint;
  confidence?: bigint;
  exponent?: number;
  publishTime?: bigint;
  previousPublishTime?: bigint;
  postedSlot?: bigint;
  executable?: boolean;
  length?: number;
} = {}): AccountInfo<Buffer> {
  const feed = MAGICBLOCK_DEMO_FEEDS[args.feedPosition ?? 0]!;
  const data = Buffer.alloc(args.length ?? 134);
  (args.discriminator ?? createHash("sha256")
    .update("account:PriceUpdateV3")
    .digest()
    .subarray(0, 8)).copy(data, 0);
  (args.writer ?? MAGICBLOCK_STORED_WRITE_AUTHORITY).toBuffer().copy(data, 8);
  data.writeUInt8(args.verification ?? 1, 40);
  (args.embeddedFeed ?? feed.address).toBuffer().copy(data, 41);
  data.writeBigInt64LE(args.price ?? 10_269_110_075n, 73);
  data.writeBigUInt64LE(args.confidence ?? 0n, 81);
  data.writeInt32LE(args.exponent ?? 8, 89);
  data.writeBigInt64LE(args.publishTime ?? BigInt(NOW - 20), 93);
  data.writeBigInt64LE(args.previousPublishTime ?? BigInt(NOW - 21), 101);
  data.writeBigUInt64LE(args.postedSlot ?? 9_000n, 125);
  return {
    data,
    executable: args.executable ?? false,
    lamports: 1,
    owner: args.owner ?? MAGICBLOCK_PRICE_PROGRAM_ID,
    rentEpoch: 0,
  };
}

test("MagicBlock demo configuration is strict and bounded", () => {
  assert.deepEqual(configuration, { maxAgeSecs: DEFAULT_MAGICBLOCK_MAX_AGE_SECS });
  assert.deepEqual(
    requireMagicBlockDemoConfiguration({ MAGICBLOCK_DEMO_MAX_AGE_SECS: "30" }),
    { maxAgeSecs: 30 },
  );
  assert.throws(
    () => requireMagicBlockDemoConfiguration({ MAGICBLOCK_DEMO_MAX_AGE_SECS: "9" }),
    MagicBlockPriceConfigurationError,
  );
  assert.throws(
    () => requireMagicBlockDemoConfiguration({ MAGICBLOCK_DEMO_MAX_AGE_SECS: "121" }),
    MagicBlockPriceConfigurationError,
  );
});

test("exact live account shape scales magnitude-8 prices to E6", () => {
  const parsed = parseMagicBlockDemoPriceAccount({
    account: priceAccount(),
    feed: MAGICBLOCK_DEMO_FEEDS[0]!,
    configuration,
    nowSecs: NOW,
  });
  assert.equal(parsed.index, 0);
  assert.equal(parsed.symbol, "SOL");
  assert.equal(parsed.priceE6, 102_691_101n);
  assert.equal(parsed.displayPrice, 102.691101);
  assert.equal(parsed.publishTime, NOW - 20);
  assert.equal(parsed.postedSlot, 9_000n);
});

test("owner, writer, discriminator, verification and feed identity fail closed", () => {
  const feed = MAGICBLOCK_DEMO_FEEDS[0]!;
  const parse = (account: AccountInfo<Buffer>) => parseMagicBlockDemoPriceAccount({
    account,
    feed,
    configuration,
    nowSecs: NOW,
  });
  assert.throws(() => parse(priceAccount({ owner: PublicKey.unique() })), MagicBlockPriceIntegrityError);
  assert.throws(() => parse(priceAccount({ writer: MAGICBLOCK_ORACLE_IDENTITY })), MagicBlockPriceIntegrityError);
  assert.throws(() => parse(priceAccount({ discriminator: Buffer.alloc(8) })), MagicBlockPriceIntegrityError);
  assert.throws(() => parse(priceAccount({ verification: 0 })), MagicBlockPriceIntegrityError);
  assert.throws(() => parse(priceAccount({ embeddedFeed: PublicKey.unique() })), MagicBlockPriceIntegrityError);
  assert.throws(() => parse(priceAccount({ executable: true })), MagicBlockPriceIntegrityError);
  assert.throws(() => parse(priceAccount({ length: 133 })), MagicBlockPriceIntegrityError);
});

test("stale, future, unordered, unposted and malformed prices fail closed", () => {
  const feed = MAGICBLOCK_DEMO_FEEDS[0]!;
  const parse = (account: AccountInfo<Buffer>) => parseMagicBlockDemoPriceAccount({
    account,
    feed,
    configuration,
    nowSecs: NOW,
  });
  assert.throws(
    () => parse(priceAccount({ publishTime: BigInt(NOW - 61), previousPublishTime: BigInt(NOW - 62) })),
    MagicBlockPriceUnavailableError,
  );
  assert.throws(
    () => parse(priceAccount({ publishTime: BigInt(NOW + 6), previousPublishTime: BigInt(NOW) })),
    MagicBlockPriceUnavailableError,
  );
  assert.throws(
    () => parse(priceAccount({ publishTime: BigInt(NOW - 2), previousPublishTime: BigInt(NOW - 1) })),
    MagicBlockPriceIntegrityError,
  );
  assert.throws(() => parse(priceAccount({ postedSlot: 0n })), MagicBlockPriceUnavailableError);
  assert.throws(() => parse(priceAccount({ price: 0n })), MagicBlockPriceUnavailableError);
  assert.throws(() => parse(priceAccount({ exponent: -8 })), MagicBlockPriceIntegrityError);
  assert.throws(
    () => parse(priceAccount({ confidence: 200_000_000n })),
    MagicBlockPriceUnavailableError,
  );
});

test("batched reader requires all three pinned feeds and returns an index-keyed set", async () => {
  const accounts = [
    priceAccount({ feedPosition: 0 }),
    priceAccount({ feedPosition: 1, price: 7_859_547_094_325n }),
    priceAccount({ feedPosition: 2, price: 438_712_345_678n }),
  ];
  let reads = 0;
  const prices = await readMagicBlockDemoPrices({
    connection: {
      async getMultipleAccountsInfo(addresses: PublicKey[]) {
        reads += 1;
        assert.deepEqual(
          addresses.map((address) => address.toBase58()),
          MAGICBLOCK_DEMO_FEEDS.map((feed) => feed.address.toBase58()),
        );
        return accounts;
      },
    },
    configuration,
    nowSecs: NOW,
  });
  assert.equal(reads, 1);
  assert.equal(prices.size, 3);
  assert.equal(prices.get(0)?.priceE6, 102_691_101n);
  assert.equal(prices.get(1)?.priceE6, 78_595_470_943n);
  assert.equal(prices.get(2)?.priceE6, 4_387_123_457n);

  await assert.rejects(
    () => readMagicBlockDemoPrices({
      connection: { async getMultipleAccountsInfo() { return [accounts[0]!, accounts[1]!, null]; } },
      configuration,
      nowSecs: NOW,
    }),
    MagicBlockPriceUnavailableError,
  );
});
