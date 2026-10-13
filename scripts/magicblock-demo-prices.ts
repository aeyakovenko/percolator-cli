import { createHash } from "node:crypto";
import {
  PublicKey,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";

/**
 * Public MagicBlock devnet demonstration endpoint and oracle deployment.
 *
 * This is intentionally a dev/test source. It has no documented production
 * SLA and must never be selected implicitly.
 */
export const MAGICBLOCK_DEMO_RPC_URL = "https://devnet.magicblock.app";
export const MAGICBLOCK_PRICE_PROGRAM_ID = new PublicKey(
  "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd",
);
export const MAGICBLOCK_ORACLE_IDENTITY = new PublicKey(
  "MPUxHCpNUy3K1CSVhebAmTbcTCKVxfk9YMDcUP2ZnEA",
);
export const MAGICBLOCK_STORED_WRITE_AUTHORITY = PublicKey.default;
export const DEFAULT_MAGICBLOCK_MAX_AGE_SECS = 60;
export const MAGICBLOCK_FUTURE_TOLERANCE_SECS = 5;

const PRICE_UPDATE_V3_DISCRIMINATOR = createHash("sha256")
  .update("account:PriceUpdateV3")
  .digest()
  .subarray(0, 8);
const PRICE_UPDATE_V3_LENGTH = 134;
const FULL_VERIFICATION_LEVEL = 1;
const EXPECTED_EXPONENT_MAGNITUDE = 8;
const U64_MAX = (1n << 64n) - 1n;
const MIN_PRICE_E6 = 10_000n; // $0.01
const MAX_PRICE_E6 = 10_000_000_000_000n; // $10m

export interface MagicBlockDemoFeed {
  index: number;
  symbol: "SOL" | "BTC" | "ETH";
  address: PublicKey;
}

export const MAGICBLOCK_DEMO_FEEDS: readonly MagicBlockDemoFeed[] = [
  {
    index: 0,
    symbol: "SOL",
    address: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
  },
  {
    index: 1,
    symbol: "BTC",
    address: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
  },
  {
    index: 2,
    symbol: "ETH",
    address: new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"),
  },
] as const;

export interface MagicBlockPriceEnvironment {
  MAGICBLOCK_DEMO_MAX_AGE_SECS?: string;
  [name: string]: string | undefined;
}

export interface MagicBlockDemoConfiguration {
  maxAgeSecs: number;
}

export interface ValidatedMagicBlockPrice {
  index: number;
  symbol: string;
  priceE6: bigint;
  displayPrice: number;
  publishTime: number;
  postedSlot: bigint;
}

export class MagicBlockPriceConfigurationError extends Error {}
export class MagicBlockPriceIntegrityError extends Error {}
export class MagicBlockPriceUnavailableError extends Error {}

export function requireMagicBlockDemoConfiguration(
  env: MagicBlockPriceEnvironment,
): MagicBlockDemoConfiguration {
  const raw = env.MAGICBLOCK_DEMO_MAX_AGE_SECS?.trim()
    || String(DEFAULT_MAGICBLOCK_MAX_AGE_SECS);
  if (!/^\d+$/.test(raw)) {
    throw new MagicBlockPriceConfigurationError(
      "MAGICBLOCK_DEMO_MAX_AGE_SECS must be an integer from 10 to 120.",
    );
  }
  const maxAgeSecs = Number(raw);
  if (!Number.isSafeInteger(maxAgeSecs) || maxAgeSecs < 10 || maxAgeSecs > 120) {
    throw new MagicBlockPriceConfigurationError(
      "MAGICBLOCK_DEMO_MAX_AGE_SECS must be an integer from 10 to 120.",
    );
  }
  return { maxAgeSecs };
}

function scaleMagnitudePriceToE6(price: bigint, exponentMagnitude: number): bigint {
  if (price <= 0n) {
    throw new MagicBlockPriceUnavailableError("MagicBlock demo price is not positive.");
  }
  if (exponentMagnitude !== EXPECTED_EXPONENT_MAGNITUDE) {
    throw new MagicBlockPriceIntegrityError(
      "MagicBlock demo exponent changed from the pinned feed contract.",
    );
  }
  const divisor = 10n ** BigInt(exponentMagnitude - 6);
  const priceE6 = (price + divisor / 2n) / divisor;
  if (priceE6 <= 0n || priceE6 > U64_MAX) {
    throw new MagicBlockPriceIntegrityError(
      "MagicBlock demo price cannot be represented as a u64 E6 mark.",
    );
  }
  if (priceE6 < MIN_PRICE_E6 || priceE6 > MAX_PRICE_E6) {
    throw new MagicBlockPriceUnavailableError(
      "MagicBlock demo price is outside the supported market bounds.",
    );
  }
  return priceE6;
}

export function parseMagicBlockDemoPriceAccount(args: {
  account: AccountInfo<Buffer>;
  feed: MagicBlockDemoFeed;
  configuration: MagicBlockDemoConfiguration;
  nowSecs: number;
}): ValidatedMagicBlockPrice {
  const { account, feed, configuration, nowSecs } = args;
  if (!Number.isSafeInteger(nowSecs) || nowSecs < 0) {
    throw new MagicBlockPriceConfigurationError(
      "Current time must be a non-negative integer.",
    );
  }
  if (!account.owner.equals(MAGICBLOCK_PRICE_PROGRAM_ID)) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} account owner does not match the pinned oracle program.`,
    );
  }
  if (account.executable || account.data.length !== PRICE_UPDATE_V3_LENGTH) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} account shape is invalid.`,
    );
  }
  if (!account.data.subarray(0, 8).equals(PRICE_UPDATE_V3_DISCRIMINATOR)) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} account discriminator is invalid.`,
    );
  }

  const writeAuthority = new PublicKey(account.data.subarray(8, 40));
  if (!writeAuthority.equals(MAGICBLOCK_STORED_WRITE_AUTHORITY)) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} stored write-authority shape changed.`,
    );
  }
  if (account.data.readUInt8(40) !== FULL_VERIFICATION_LEVEL) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} account is not marked fully verified.`,
    );
  }
  const feedId = new PublicKey(account.data.subarray(41, 73));
  if (!feedId.equals(feed.address)) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} embedded feed identity is invalid.`,
    );
  }

  const rawPrice = account.data.readBigInt64LE(73);
  const confidence = account.data.readBigUInt64LE(81);
  const exponentMagnitude = account.data.readInt32LE(89);
  const publishTimeBig = account.data.readBigInt64LE(93);
  const previousPublishTimeBig = account.data.readBigInt64LE(101);
  const postedSlot = account.data.readBigUInt64LE(125);
  if (publishTimeBig < 0n || publishTimeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} publish time is invalid.`,
    );
  }
  if (previousPublishTimeBig < 0n || previousPublishTimeBig > publishTimeBig) {
    throw new MagicBlockPriceIntegrityError(
      `MagicBlock ${feed.symbol} publish-time ordering is invalid.`,
    );
  }
  if (postedSlot === 0n) {
    throw new MagicBlockPriceUnavailableError(
      `MagicBlock ${feed.symbol} feed has not posted a live update.`,
    );
  }

  const publishTime = Number(publishTimeBig);
  if (publishTime > nowSecs + MAGICBLOCK_FUTURE_TOLERANCE_SECS) {
    throw new MagicBlockPriceUnavailableError(
      `MagicBlock ${feed.symbol} publish time is in the future.`,
    );
  }
  if (nowSecs - publishTime > configuration.maxAgeSecs) {
    throw new MagicBlockPriceUnavailableError(
      `MagicBlock ${feed.symbol} feed is stale.`,
    );
  }
  if (rawPrice <= 0n) {
    throw new MagicBlockPriceUnavailableError(
      `MagicBlock ${feed.symbol} price is not positive.`,
    );
  }
  // The public demo currently publishes no confidence interval. Reject any
  // future non-zero value wider than 1%; never silently ignore the field.
  if (confidence * 10_000n > rawPrice * 100n) {
    throw new MagicBlockPriceUnavailableError(
      `MagicBlock ${feed.symbol} confidence interval is too wide.`,
    );
  }

  const priceE6 = scaleMagnitudePriceToE6(rawPrice, exponentMagnitude);
  return {
    index: feed.index,
    symbol: feed.symbol,
    priceE6,
    displayPrice: Number(priceE6) / 1_000_000,
    publishTime,
    postedSlot,
  };
}

export interface MagicBlockAccountReader {
  getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitment?: "confirmed",
  ): Promise<Array<AccountInfo<Buffer> | null>>;
}

export async function readMagicBlockDemoPrices(args: {
  connection: Pick<Connection, "getMultipleAccountsInfo"> | MagicBlockAccountReader;
  configuration: MagicBlockDemoConfiguration;
  nowSecs: number;
}): Promise<Map<number, ValidatedMagicBlockPrice>> {
  const accounts = await args.connection.getMultipleAccountsInfo(
    MAGICBLOCK_DEMO_FEEDS.map((feed) => feed.address),
    "confirmed",
  );
  if (accounts.length !== MAGICBLOCK_DEMO_FEEDS.length) {
    throw new MagicBlockPriceUnavailableError(
      "MagicBlock demo returned an incomplete account batch.",
    );
  }

  const prices = new Map<number, ValidatedMagicBlockPrice>();
  for (let position = 0; position < MAGICBLOCK_DEMO_FEEDS.length; position += 1) {
    const feed = MAGICBLOCK_DEMO_FEEDS[position]!;
    const account = accounts[position];
    if (!account) {
      throw new MagicBlockPriceUnavailableError(
        `MagicBlock ${feed.symbol} feed account is unavailable.`,
      );
    }
    const price = parseMagicBlockDemoPriceAccount({
      account,
      feed,
      configuration: args.configuration,
      nowSecs: args.nowSecs,
    });
    prices.set(feed.index, price);
  }
  return prices;
}
