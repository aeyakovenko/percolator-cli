import { createHash } from "node:crypto";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";

/** Upgraded Pyth Core push-oracle program used to derive shard/feed PDAs. */
export const PYTH_CORE_PUSH_ORACLE_PROGRAM_ID = new PublicKey(
  "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou",
);
/** Upgraded Pyth receiver owns the PriceUpdateV2 PDA accounts. */
export const PYTH_SOLANA_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp",
);
/** Legacy deployment remains a bounded migration fallback while it is live. */
export const PYTH_LEGACY_PUSH_ORACLE_PROGRAM_ID = new PublicKey(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
);
export const PYTH_LEGACY_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);
export const PYTH_SPONSORED_SHARD = 0;
export const DEFAULT_PYTH_PUSH_MAX_AGE_SECS = 300;
export const DEFAULT_PYTH_PUSH_MAX_CONFIDENCE_BPS = 100;
export const PYTH_FUTURE_TOLERANCE_SECS = 5;

const PRICE_UPDATE_V2_DISCRIMINATOR = createHash("sha256")
  .update("account:PriceUpdateV2")
  .digest()
  .subarray(0, 8);
const PRICE_UPDATE_V2_FULL_OFFSET = 41;
const PRICE_UPDATE_V2_MIN_LENGTH = 133;
const U64_MAX = (1n << 64n) - 1n;

export type PythPriceSource = "solana-push" | "hermes";

export interface PythPriceEnvironment {
  PYTH_PRICE_SOURCE?: string;
  PYTH_PUSH_MAX_AGE_SECS?: string;
  PYTH_PUSH_MAX_CONFIDENCE_BPS?: string;
  [name: string]: string | undefined;
}

export interface PythPriceSourceConfiguration {
  source: PythPriceSource;
  maxAgeSecs: number;
  maxConfidenceBps: number;
}

export interface PythFeedDescriptor {
  index: number;
  symbol: string;
  feedId: string;
}

export interface PythPriceComponents {
  price: string;
  confidence: string;
  exponent: number;
  publishTime: number;
}

export interface ValidatedPythPrice {
  priceE6: bigint;
  displayPrice: number;
  publishTime: number;
}

export interface AvailablePythPushPrices {
  feeds: Map<string, ValidatedPythPrice>;
  unavailableIndexes: number[];
}

export class PythPriceConfigurationError extends Error {}
export class PythPriceIntegrityError extends Error {}
export class PythPriceUnavailableError extends Error {}

function parseBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = value?.trim() || String(fallback);
  if (!/^\d+$/.test(normalized)) {
    throw new PythPriceConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new PythPriceConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

export function requirePythPriceSourceConfiguration(
  env: PythPriceEnvironment,
): PythPriceSourceConfiguration {
  const source = env.PYTH_PRICE_SOURCE?.trim() || "solana-push";
  if (source !== "solana-push" && source !== "hermes") {
    throw new PythPriceConfigurationError(
      "PYTH_PRICE_SOURCE must be either solana-push or hermes.",
    );
  }
  return {
    source,
    maxAgeSecs: parseBoundedInteger(
      "PYTH_PUSH_MAX_AGE_SECS",
      env.PYTH_PUSH_MAX_AGE_SECS,
      DEFAULT_PYTH_PUSH_MAX_AGE_SECS,
      30,
      300,
    ),
    maxConfidenceBps: parseBoundedInteger(
      "PYTH_PUSH_MAX_CONFIDENCE_BPS",
      env.PYTH_PUSH_MAX_CONFIDENCE_BPS,
      DEFAULT_PYTH_PUSH_MAX_CONFIDENCE_BPS,
      1,
      1_000,
    ),
  };
}

function normalizeFeedId(feedId: string): string {
  const normalized = feedId.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new PythPriceConfigurationError("Pyth feed ID must be exactly 32 bytes of hex.");
  }
  return normalized;
}

export function getPythPushAccountAddress(
  feedId: string,
  pushProgramId = PYTH_CORE_PUSH_ORACLE_PROGRAM_ID,
): PublicKey {
  const shard = Buffer.alloc(2);
  shard.writeUInt16LE(PYTH_SPONSORED_SHARD);
  return PublicKey.findProgramAddressSync(
    [shard, Buffer.from(normalizeFeedId(feedId), "hex")],
    pushProgramId,
  )[0];
}

export function getPythPushAccountCandidates(feedId: string): Array<{
  address: PublicKey;
  owner: PublicKey;
}> {
  return [
    {
      address: getPythPushAccountAddress(feedId, PYTH_CORE_PUSH_ORACLE_PROGRAM_ID),
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    },
    {
      address: getPythPushAccountAddress(feedId, PYTH_LEGACY_PUSH_ORACLE_PROGRAM_ID),
      owner: PYTH_LEGACY_RECEIVER_PROGRAM_ID,
    },
  ];
}

function readSignedI64(data: Buffer, offset: number): bigint {
  return data.readBigInt64LE(offset);
}

export function scalePythPriceToE6(price: bigint, exponent: number): bigint {
  if (price <= 0n) throw new PythPriceUnavailableError("Pyth price is not positive.");
  if (!Number.isSafeInteger(exponent) || exponent < -18 || exponent > 18) {
    throw new PythPriceIntegrityError("Pyth exponent is outside the supported range.");
  }
  const shift = exponent + 6;
  let priceE6: bigint;
  if (shift >= 0) {
    priceE6 = price * (10n ** BigInt(shift));
  } else {
    const divisor = 10n ** BigInt(-shift);
    priceE6 = (price + divisor / 2n) / divisor;
  }
  if (priceE6 <= 0n || priceE6 > U64_MAX) {
    throw new PythPriceIntegrityError("Pyth price cannot be represented as a u64 E6 mark.");
  }
  return priceE6;
}

export function validatePythPrice(
  components: PythPriceComponents,
  configuration: PythPriceSourceConfiguration,
  nowSecs: number,
): ValidatedPythPrice {
  if (!/^-?\d+$/.test(components.price) || !/^\d+$/.test(components.confidence)) {
    throw new PythPriceIntegrityError("Pyth price or confidence is not an integer.");
  }
  if (!Number.isSafeInteger(components.publishTime) || components.publishTime < 0) {
    throw new PythPriceIntegrityError("Pyth publish time is invalid.");
  }
  if (!Number.isSafeInteger(nowSecs) || nowSecs < 0) {
    throw new PythPriceConfigurationError("Current time must be a non-negative integer.");
  }
  if (components.publishTime > nowSecs + PYTH_FUTURE_TOLERANCE_SECS) {
    throw new PythPriceUnavailableError("Pyth price publish time is in the future.");
  }
  if (nowSecs - components.publishTime > configuration.maxAgeSecs) {
    throw new PythPriceUnavailableError("Pyth price is stale.");
  }

  const rawPrice = BigInt(components.price);
  const confidence = BigInt(components.confidence);
  if (rawPrice <= 0n) throw new PythPriceUnavailableError("Pyth price is not positive.");
  if (confidence * 10_000n > rawPrice * BigInt(configuration.maxConfidenceBps)) {
    throw new PythPriceUnavailableError("Pyth confidence interval is too wide.");
  }
  const priceE6 = scalePythPriceToE6(rawPrice, components.exponent);
  return {
    priceE6,
    displayPrice: Number(priceE6) / 1_000_000,
    publishTime: components.publishTime,
  };
}

export function parsePythPushPriceAccount(
  account: AccountInfo<Buffer>,
  expectedFeedId: string,
  configuration: PythPriceSourceConfiguration,
  nowSecs: number,
  expectedOwner = PYTH_SOLANA_RECEIVER_PROGRAM_ID,
): ValidatedPythPrice {
  if (!account.owner.equals(expectedOwner)) {
    throw new PythPriceIntegrityError("Pyth push account owner is invalid.");
  }
  const data = Buffer.from(account.data);
  if (data.length < PRICE_UPDATE_V2_MIN_LENGTH) {
    throw new PythPriceIntegrityError("Pyth push account layout is unavailable.");
  }
  if (!data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) {
    throw new PythPriceIntegrityError("Pyth push account discriminator is invalid.");
  }
  // Anchor enum: Partial = 0 followed by num_signatures; Full = 1 with no payload.
  if (data.readUInt8(40) !== 1) {
    throw new PythPriceIntegrityError("Pyth push update is not fully verified.");
  }
  const expected = normalizeFeedId(expectedFeedId);
  if (data.subarray(PRICE_UPDATE_V2_FULL_OFFSET, PRICE_UPDATE_V2_FULL_OFFSET + 32).toString("hex") !== expected) {
    throw new PythPriceIntegrityError("Pyth push account feed identity is invalid.");
  }
  const exponent = data.readInt32LE(89);
  const publishTime = readSignedI64(data, 93);
  if (publishTime < 0n || publishTime > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PythPriceIntegrityError("Pyth push account publish time is invalid.");
  }
  return validatePythPrice({
    price: readSignedI64(data, 73).toString(),
    confidence: data.readBigUInt64LE(81).toString(),
    exponent,
    publishTime: Number(publishTime),
  }, configuration, nowSecs);
}

export async function readPythPushPrices(args: {
  connection: Pick<Connection, "getMultipleAccountsInfo">;
  feeds: readonly PythFeedDescriptor[];
  configuration: PythPriceSourceConfiguration;
  nowSecs: number;
}): Promise<AvailablePythPushPrices> {
  const candidates = args.feeds.map((feed) => getPythPushAccountCandidates(feed.feedId));
  const addresses = candidates.flatMap((feedCandidates) => feedCandidates.map((candidate) => candidate.address));
  const accounts = await args.connection.getMultipleAccountsInfo(addresses, "confirmed");
  if (accounts.length !== addresses.length) {
    throw new PythPriceIntegrityError("Pyth push account response length is invalid.");
  }
  const feeds = new Map<string, ValidatedPythPrice>();
  const unavailableIndexes: number[] = [];
  let accountOffset = 0;
  for (let feedIndex = 0; feedIndex < args.feeds.length; feedIndex += 1) {
    const descriptor = args.feeds[feedIndex];
    const feedCandidates = candidates[feedIndex];
    let selected: ValidatedPythPrice | null = null;
    for (const candidate of feedCandidates) {
      const account = accounts[accountOffset];
      accountOffset += 1;
      if (!account) continue;
      try {
        const parsed = parsePythPushPriceAccount(
          account,
          descriptor.feedId,
          args.configuration,
          args.nowSecs,
          candidate.owner,
        );
        if (!selected || parsed.publishTime > selected.publishTime) selected = parsed;
      } catch (error) {
        if (error instanceof PythPriceUnavailableError) continue;
        throw error;
      }
    }
    if (selected) feeds.set(descriptor.feedId, selected);
    else unavailableIndexes.push(descriptor.index);
  }
  if (feeds.size === 0) {
    throw new PythPriceUnavailableError("No fresh sponsored Pyth push feeds are available.");
  }
  return { feeds, unavailableIndexes };
}
