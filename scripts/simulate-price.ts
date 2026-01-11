/**
 * Simulate trade prices using the passive LP matcher logic
 *
 * The 50bps matcher quotes:
 *   bid = floor(oracle * 0.995)  - price when user sells
 *   ask = ceil(oracle * 1.005)   - price when user buys
 */
import { Connection, PublicKey } from '@solana/web3.js';

const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');
const EDGE_BPS = 50n;
const BPS_DENOM = 10000n;

interface Quote {
  oracle: bigint;
  bid: bigint;
  ask: bigint;
  spreadBps: number;
}

function computeQuote(oraclePrice: bigint): Quote {
  // bid = floor(oracle * (10000 - edge) / 10000)
  const bid = (oraclePrice * (BPS_DENOM - EDGE_BPS)) / BPS_DENOM;

  // ask = ceil(oracle * (10000 + edge) / 10000)
  const askNumer = oraclePrice * (BPS_DENOM + EDGE_BPS);
  const ask = (askNumer + BPS_DENOM - 1n) / BPS_DENOM;

  const spreadBps = Number((ask - bid) * 10000n / oraclePrice);

  return { oracle: oraclePrice, bid, ask, spreadBps };
}

async function getChainlinkPrice(connection: Connection): Promise<{ price: bigint; decimals: number }> {
  const info = await connection.getAccountInfo(ORACLE);
  if (!info) throw new Error('Oracle not found');

  const data = info.data;
  const decimals = data.readUInt8(138);
  const answer = data.readBigInt64LE(216);

  return { price: answer, decimals };
}

async function main() {
  const connection = new Connection('https://api.devnet.solana.com');

  // Get oracle price
  const { price: rawPrice, decimals } = await getChainlinkPrice(connection);
  const oraclePrice = rawPrice; // Keep in raw format for calculations
  const oraclePriceUsd = Number(rawPrice) / Math.pow(10, decimals);

  console.log('=== Trade Price Simulator ===\n');
  console.log(`Oracle: $${oraclePriceUsd.toFixed(2)} (${rawPrice} raw, ${decimals} decimals)`);
  console.log(`Matcher: 50bps passive spread\n`);

  // Compute quotes
  const quote = computeQuote(oraclePrice);
  const bidUsd = Number(quote.bid) / Math.pow(10, decimals);
  const askUsd = Number(quote.ask) / Math.pow(10, decimals);

  console.log('=== Quotes ===');
  console.log(`Bid (user sells): $${bidUsd.toFixed(4)} (${quote.bid})`);
  console.log(`Ask (user buys):  $${askUsd.toFixed(4)} (${quote.ask})`);
  console.log(`Spread: ${quote.spreadBps} bps (~${(quote.spreadBps / 100).toFixed(2)}%)\n`);

  // Simulate various trade sizes
  console.log('=== Simulated Executions ===');
  const sizes = [100n, 1000n, 10000n, 100000n];

  console.log('\nBUY (user goes long, pays ask):');
  for (const size of sizes) {
    const cost = size * quote.ask;
    const costScaled = Number(cost) / Math.pow(10, decimals);
    console.log(`  Size ${size.toString().padStart(6)}: exec @ $${askUsd.toFixed(4)}, cost = ${costScaled.toFixed(6)} quote units`);
  }

  console.log('\nSELL (user goes short, receives bid):');
  for (const size of sizes) {
    const proceeds = size * quote.bid;
    const proceedsScaled = Number(proceeds) / Math.pow(10, decimals);
    console.log(`  Size ${size.toString().padStart(6)}: exec @ $${bidUsd.toFixed(4)}, proceeds = ${proceedsScaled.toFixed(6)} quote units`);
  }

  console.log('\n=== Best Price Analysis ===');
  console.log('With only one LP (50bps passive matcher), the best price is:');
  console.log(`  - BUY:  $${askUsd.toFixed(4)} (oracle + 50bps)`);
  console.log(`  - SELL: $${bidUsd.toFixed(4)} (oracle - 50bps)`);
  console.log('\nTo get better prices, you would need additional LPs with tighter spreads.');
}

main().catch(console.error);
