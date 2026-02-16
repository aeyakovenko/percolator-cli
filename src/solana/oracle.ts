/**
 * Oracle account parsing utilities.
 *
 * Chainlink aggregator layout on Solana:
 *   offset 138: decimals (u8)
 *   offset 216: latest answer (i64 LE)
 *
 * Minimum account size: 224 bytes (offset 216 + 8 bytes for i64).
 */

/** Minimum buffer size to read Chainlink price data */
const CHAINLINK_MIN_SIZE = 224; // 216 + 8

/** Maximum reasonable decimals for a price feed */
const MAX_DECIMALS = 18;

/** Offset of decimals field in Chainlink aggregator account */
const CHAINLINK_DECIMALS_OFFSET = 138;

/** Offset of latest answer in Chainlink aggregator account */
const CHAINLINK_ANSWER_OFFSET = 216;

export interface OraclePrice {
  price: bigint;
  decimals: number;
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

  return { price, decimals };
}
