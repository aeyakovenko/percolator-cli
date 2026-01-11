/**
 * Scan slab for LPs, simulate matchers, and find best price
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { parseUsedIndices, parseAccount, parseConfig } from '../src/solana/slab.js';

const SLAB = new PublicKey('CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

// Matcher program constants
const PASSIVE_MATCHER_EDGE_BPS = 50n;
const BPS_DENOM = 10000n;

interface LpInfo {
  index: number;
  owner: PublicKey;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  capital: bigint;
  position: bigint;
}

interface Quote {
  lpIndex: number;
  bid: bigint;
  ask: bigint;
  edgeBps: number;
}

function computePassiveQuote(oraclePrice: bigint, edgeBps: bigint): { bid: bigint; ask: bigint } {
  const bid = (oraclePrice * (BPS_DENOM - edgeBps)) / BPS_DENOM;
  const askNumer = oraclePrice * (BPS_DENOM + edgeBps);
  const ask = (askNumer + BPS_DENOM - 1n) / BPS_DENOM;
  return { bid, ask };
}

async function getChainlinkPrice(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(ORACLE);
  if (!info) throw new Error('Oracle not found');
  return info.data.readBigInt64LE(216);
}

// Read matcher context to get edge_bps (if stored) - for passive matcher it's fixed at 50bps
async function getMatcherEdge(connection: Connection, matcherCtx: PublicKey): Promise<number> {
  // The passive matcher uses fixed 50bps - stored in code, not context
  // Context only stores: return data (64 bytes) + LP PDA (32 bytes)
  // For now, assume all matchers are 50bps passive
  return 50;
}

async function main() {
  const connection = new Connection('https://api.devnet.solana.com');

  // Get slab data
  const slabInfo = await connection.getAccountInfo(SLAB);
  if (!slabInfo) throw new Error('Slab not found');

  // Get oracle price
  const oraclePrice = await getChainlinkPrice(connection);
  const oraclePriceUsd = Number(oraclePrice) / 1e8; // Chainlink uses 8 decimals

  console.log('=== Best Price Scanner ===\n');
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Oracle: $${oraclePriceUsd.toFixed(2)} (${oraclePrice})\n`);

  // Find all LPs
  const usedIndices = parseUsedIndices(slabInfo.data);
  const lps: LpInfo[] = [];

  console.log('=== Scanning LPs ===');
  for (const idx of usedIndices) {
    const account = parseAccount(slabInfo.data, idx);
    if (!account) continue;

    // LP detection: matcher_program is non-zero
    const isLp = account.matcherProgram && !account.matcherProgram.equals(PublicKey.default);

    if (isLp) {
      lps.push({
        index: idx,
        owner: account.owner,
        matcherProgram: account.matcherProgram!,
        matcherContext: account.matcherContext!,
        capital: account.capital,
        position: account.positionSize,
      });
      console.log(`LP ${idx}:`);
      console.log(`  Matcher: ${account.matcherProgram!.toBase58().slice(0, 20)}...`);
      console.log(`  Capital: ${(Number(account.capital) / 1e9).toFixed(4)} SOL`);
      console.log(`  Position: ${account.positionSize}`);
    }
  }

  if (lps.length === 0) {
    console.log('\nNo LPs found!');
    return;
  }

  // Simulate quotes for each LP
  console.log('\n=== Simulated Quotes ===');
  const quotes: Quote[] = [];

  for (const lp of lps) {
    const edgeBps = await getMatcherEdge(connection, lp.matcherContext);
    const { bid, ask } = computePassiveQuote(oraclePrice, BigInt(edgeBps));

    quotes.push({
      lpIndex: lp.index,
      bid,
      ask,
      edgeBps,
    });

    const bidUsd = Number(bid) / 1e8;
    const askUsd = Number(ask) / 1e8;
    console.log(`LP ${lp.index} (${edgeBps}bps spread):`);
    console.log(`  Bid: $${bidUsd.toFixed(4)}`);
    console.log(`  Ask: $${askUsd.toFixed(4)}`);
  }

  // Find best prices
  console.log('\n=== Best Prices ===');

  // Best for buying (lowest ask)
  const bestBuy = quotes.reduce((best, q) => q.ask < best.ask ? q : best);
  const bestBuyUsd = Number(bestBuy.ask) / 1e8;
  console.log(`BEST BUY:  LP ${bestBuy.lpIndex} @ $${bestBuyUsd.toFixed(4)} (${bestBuy.edgeBps}bps spread)`);

  // Best for selling (highest bid)
  const bestSell = quotes.reduce((best, q) => q.bid > best.bid ? q : best);
  const bestSellUsd = Number(bestSell.bid) / 1e8;
  console.log(`BEST SELL: LP ${bestSell.lpIndex} @ $${bestSellUsd.toFixed(4)} (${bestSell.edgeBps}bps spread)`);

  // Summary
  console.log('\n=== Recommendation ===');
  console.log(`To BUY (go long):  trade against LP ${bestBuy.lpIndex}`);
  console.log(`To SELL (go short): trade against LP ${bestSell.lpIndex}`);
  console.log(`\nEffective spread: ${(Number(bestBuy.ask - bestSell.bid) / Number(oraclePrice) * 10000).toFixed(1)} bps`);
}

main().catch(console.error);
