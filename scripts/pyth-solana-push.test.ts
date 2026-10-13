import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  DEFAULT_PYTH_PUSH_MAX_AGE_SECS,
  DEFAULT_PYTH_PUSH_MAX_CONFIDENCE_BPS,
  PYTH_CORE_PUSH_ORACLE_PROGRAM_ID,
  PYTH_LEGACY_RECEIVER_PROGRAM_ID,
  PYTH_SOLANA_RECEIVER_PROGRAM_ID,
  PythPriceConfigurationError,
  PythPriceIntegrityError,
  PythPriceUnavailableError,
  getPythPushAccountAddress,
  getPythPushAccountCandidates,
  parsePythPushPriceAccount,
  readPythPushPrices,
  requirePythPriceSourceConfiguration,
  scalePythPriceToE6,
} from "./pyth-solana-push.ts";

const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const BTC_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const NOW = 1_800_000_000;
const configuration = requirePythPriceSourceConfiguration({});

function priceAccount(args: {
  feedId?: string;
  owner?: PublicKey;
  verificationLevel?: number;
  price?: bigint;
  confidence?: bigint;
  exponent?: number;
  publishTime?: bigint;
  discriminator?: Buffer;
} = {}): AccountInfo<Buffer> {
  const data = Buffer.alloc(134);
  const discriminator = args.discriminator ?? createHash("sha256")
    .update("account:PriceUpdateV2")
    .digest()
    .subarray(0, 8);
  discriminator.copy(data, 0);
  data.writeUInt8(args.verificationLevel ?? 1, 40);
  Buffer.from(args.feedId ?? SOL_FEED, "hex").copy(data, 41);
  data.writeBigInt64LE(args.price ?? 17_512_345_678n, 73);
  data.writeBigUInt64LE(args.confidence ?? 2_000_000n, 81);
  data.writeInt32LE(args.exponent ?? -8, 89);
  data.writeBigInt64LE(args.publishTime ?? BigInt(NOW - 30), 93);
  return {
    data,
    executable: false,
    lamports: 1,
    owner: args.owner ?? PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    rentEpoch: 0,
  };
}

test("sponsored push source is the safe default and bounds validation policy", () => {
  assert.deepEqual(requirePythPriceSourceConfiguration({}), {
    source: "solana-push",
    maxAgeSecs: DEFAULT_PYTH_PUSH_MAX_AGE_SECS,
    maxConfidenceBps: DEFAULT_PYTH_PUSH_MAX_CONFIDENCE_BPS,
  });
  assert.equal(requirePythPriceSourceConfiguration({ PYTH_PRICE_SOURCE: "hermes" }).source, "hermes");
  assert.throws(
    () => requirePythPriceSourceConfiguration({ PYTH_PRICE_SOURCE: "exchange" }),
    PythPriceConfigurationError,
  );
  assert.throws(
    () => requirePythPriceSourceConfiguration({ PYTH_PUSH_MAX_AGE_SECS: "301" }),
    PythPriceConfigurationError,
  );
  assert.throws(
    () => requirePythPriceSourceConfiguration({ PYTH_PUSH_MAX_CONFIDENCE_BPS: "0" }),
    PythPriceConfigurationError,
  );
});

test("sponsored shard PDA is deterministic under the upgraded fixed program", () => {
  assert.equal(
    getPythPushAccountAddress(`0x${SOL_FEED}`).toBase58(),
    getPythPushAccountAddress(SOL_FEED).toBase58(),
  );
  assert.notEqual(getPythPushAccountAddress(SOL_FEED).toBase58(), getPythPushAccountAddress(BTC_FEED).toBase58());
  assert.equal(getPythPushAccountCandidates(SOL_FEED).length, 2);
  assert.throws(() => getPythPushAccountAddress("not-a-feed"), PythPriceConfigurationError);
});

test("fully verified fresh account produces an exact rounded E6 mark", () => {
  const parsed = parsePythPushPriceAccount(priceAccount(), SOL_FEED, configuration, NOW);
  assert.equal(parsed.priceE6, 175_123_457n);
  assert.equal(parsed.displayPrice, 175.123457);
  assert.equal(parsed.publishTime, NOW - 30);
  assert.equal(scalePythPriceToE6(1_234_567n, -6), 1_234_567n);
  assert.equal(scalePythPriceToE6(12_345n, -8), 123n);
});

test("push account identity and verification failures fail closed", () => {
  assert.throws(
    () => parsePythPushPriceAccount(
      priceAccount({ owner: PublicKey.unique() }),
      SOL_FEED,
      configuration,
      NOW,
    ),
    PythPriceIntegrityError,
  );
  assert.throws(
    () => parsePythPushPriceAccount(
      priceAccount({ discriminator: Buffer.alloc(8) }),
      SOL_FEED,
      configuration,
      NOW,
    ),
    PythPriceIntegrityError,
  );
  assert.throws(
    () => parsePythPushPriceAccount(
      priceAccount({ verificationLevel: 0 }),
      SOL_FEED,
      configuration,
      NOW,
    ),
    PythPriceIntegrityError,
  );
  assert.throws(
    () => parsePythPushPriceAccount(priceAccount({ feedId: BTC_FEED }), SOL_FEED, configuration, NOW),
    PythPriceIntegrityError,
  );
});

test("stale, future, nonpositive, and wide-confidence prices are unavailable", () => {
  for (const account of [
    priceAccount({ publishTime: BigInt(NOW - configuration.maxAgeSecs - 1) }),
    priceAccount({ publishTime: BigInt(NOW + 6) }),
    priceAccount({ price: 0n }),
    priceAccount({ confidence: 200_000_000n }),
  ]) {
    assert.throws(
      () => parsePythPushPriceAccount(account, SOL_FEED, configuration, NOW),
      PythPriceUnavailableError,
    );
  }
});

test("one unavailable sponsored account does not block a healthy major", async () => {
  const result = await readPythPushPrices({
    connection: {
      getMultipleAccountsInfo: async () => [
        priceAccount({ publishTime: BigInt(NOW - 20) }),
        priceAccount({
          owner: PYTH_LEGACY_RECEIVER_PROGRAM_ID,
          publishTime: BigInt(NOW - 10),
        }),
        null,
        null,
      ],
    },
    feeds: [
      { index: 0, symbol: "SOL", feedId: SOL_FEED },
      { index: 1, symbol: "BTC", feedId: BTC_FEED },
    ],
    configuration,
    nowSecs: NOW,
  });
  assert.equal(result.feeds.size, 1);
  assert.equal(result.feeds.get(SOL_FEED)?.publishTime, NOW - 10);
  assert.deepEqual(result.unavailableIndexes, [1]);

  await assert.rejects(
    readPythPushPrices({
      connection: { getMultipleAccountsInfo: async () => [null, null, null, null] },
      feeds: [
        { index: 0, symbol: "SOL", feedId: SOL_FEED },
        { index: 1, symbol: "BTC", feedId: BTC_FEED },
      ],
      configuration,
      nowSecs: NOW,
    }),
    PythPriceUnavailableError,
  );
});
