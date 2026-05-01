/**
 * Oracle account parsing utilities.
 *
 * Chainlink aggregator layout on Solana:
 *   offset 138: decimals (u8)
 *   offset 208: latest timestamp (u64 LE, unix seconds)
 *   offset 216: latest answer (i64 LE)
 *
 * Minimum account size: 224 bytes (offset 216 + 8 bytes for i64).
 */

const CHAINLINK_MIN_SIZE = 224;
const MAX_DECIMALS = 18;
const CHAINLINK_DECIMALS_OFFSET = 138;
const CHAINLINK_TIMESTAMP_OFFSET = 208;
const CHAINLINK_ANSWER_OFFSET = 216;

export interface OraclePrice {
  price: bigint;
  decimals: number;
  timestamp: number;
}

/**
 * Parse price data from a Chainlink aggregator account buffer.
 *
 * Validates:
 * - Buffer is large enough to contain the required fields
 * - Decimals are in a reasonable range (0-18)
 * - Price is positive (non-zero)
 *
 * @throws if the buffer is invalid or contains unreasonable data
 */
export function parseChainlinkPrice(data: Buffer): OraclePrice {
  if (data.length < CHAINLINK_MIN_SIZE) {
    throw new Error(
      `Oracle account data too small: ${data.length} bytes (need at least ${CHAINLINK_MIN_SIZE})`
    );
  }

  const decimals = data.readUInt8(CHAINLINK_DECIMALS_OFFSET);
  if (decimals > MAX_DECIMALS) {
    throw new Error(
      `Oracle decimals out of range: ${decimals} (max ${MAX_DECIMALS})`
    );
  }

  const price = data.readBigInt64LE(CHAINLINK_ANSWER_OFFSET);
  if (price <= 0n) {
    throw new Error(
      `Oracle price is non-positive: ${price}`
    );
  }

  const timestamp = Number(data.readBigUInt64LE(CHAINLINK_TIMESTAMP_OFFSET));
  const now = Math.floor(Date.now() / 1000);
  const ONE_HOUR = 3600;
  if (timestamp > now) {
    throw new Error(
      `Oracle timestamp is in the future: ${timestamp} (now: ${now})`
    );
  }
  if (timestamp < now - ONE_HOUR) {
    throw new Error(
      `Oracle timestamp is stale: ${timestamp} (now: ${now}, max age: ${ONE_HOUR}s)`
    );
  }

  return { price, decimals, timestamp };
}
