import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;

// Use CORRECT offsets matching Rust struct
const ACCT_ACCOUNT_ID_OFF = 0;
const ACCT_CAPITAL_OFF = 8;
const ACCT_KIND_OFF = 24;
const ACCT_PNL_OFF = 32;
const ACCT_RESERVED_PNL_OFF = 48;
const ACCT_WARMUP_STARTED_OFF = 56;
const ACCT_WARMUP_SLOPE_OFF = 64;
const ACCT_POSITION_SIZE_OFF = 80;  // Correct: matches Rust offset
const ACCT_ENTRY_PRICE_OFF = 96;    // Correct: matches Rust offset

function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

async function main() {
  const data = await fetchSlab(connection, SLAB);
  console.log('Slab length:', data.length);

  // Get current oracle price
  const oraclePriceRaw = data.readBigUInt64LE(328 + 96);  // oracle_price offset in RiskEngine
  console.log('Oracle price:', oraclePriceRaw);

  for (const idx of [1, 2, 3, 4, 5]) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    console.log(`\n=== Account index ${idx} (base ${base}) ===`);

    const accountId = data.readBigUInt64LE(base + ACCT_ACCOUNT_ID_OFF);
    const capital = readU128LE(data, base + ACCT_CAPITAL_OFF);
    const kind = data.readUInt8(base + ACCT_KIND_OFF);
    const pnl = readI128LE(data, base + ACCT_PNL_OFF);
    const reservedPnl = data.readBigUInt64LE(base + ACCT_RESERVED_PNL_OFF);
    const warmupStarted = data.readBigUInt64LE(base + ACCT_WARMUP_STARTED_OFF);
    const warmupSlope = readU128LE(data, base + ACCT_WARMUP_SLOPE_OFF);
    const positionSize = readI128LE(data, base + ACCT_POSITION_SIZE_OFF);
    const entryPrice = data.readBigUInt64LE(base + ACCT_ENTRY_PRICE_OFF);

    console.log(`accountId: ${accountId}`);
    console.log(`capital: ${capital} (${(Number(capital) / 1e9).toFixed(4)} SOL)`);
    console.log(`kind: ${kind} (${kind === 0 ? 'User' : kind === 1 ? 'LP' : 'Unknown'})`);
    console.log(`pnl: ${pnl} (${(Number(pnl) / 1e9).toFixed(4)} SOL)`);
    console.log(`reserved_pnl: ${reservedPnl}`);
    console.log(`warmup_started: ${warmupStarted}`);
    console.log(`warmup_slope: ${warmupSlope}`);
    console.log(`position_size: ${positionSize} (${(Number(positionSize) / 1e9).toFixed(4)} units)`);
    console.log(`entry_price: ${entryPrice}`);

    if (positionSize !== 0n) {
      const oraclePrice = oraclePriceRaw;
      const markPnl = positionSize * (BigInt(oraclePrice) - entryPrice) / 1000000n;
      const equity = BigInt(capital) + pnl + markPnl;
      const absPos = positionSize < 0n ? -positionSize : positionSize;
      const maintReq = absPos * BigInt(oraclePrice) / 1000000n * 500n / 10000n;

      console.log(`  >> mark_pnl: ${markPnl} (${(Number(markPnl) / 1e9).toFixed(4)} SOL)`);
      console.log(`  >> equity: ${equity} (${(Number(equity) / 1e9).toFixed(4)} SOL)`);
      console.log(`  >> maint_req: ${maintReq} (${(Number(maintReq) / 1e9).toFixed(4)} SOL)`);
      console.log(`  >> LIQUIDATABLE: ${equity < maintReq}`);
    }
  }
}

main().catch(console.error);
