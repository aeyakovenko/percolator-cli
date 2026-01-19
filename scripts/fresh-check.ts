/**
 * Fresh check of accounts using correct offsets
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;

// Correct offsets for Account struct
const ACCT_ACCOUNT_ID_OFF = 0;
const ACCT_CAPITAL_OFF = 8;
const ACCT_KIND_OFF = 24;
const ACCT_PNL_OFF = 32;
const ACCT_RESERVED_PNL_OFF = 48;
const ACCT_WARMUP_STARTED_OFF = 64;
const ACCT_WARMUP_SLOPE_OFF = 72;
const ACCT_POSITION_SIZE_OFF = 88;  // Corrected from 80
const ACCT_ENTRY_PRICE_OFF = 104;   // Corrected from 96

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

  console.log('=== Accounts with corrected offsets ===\n');

  for (const idx of [1, 2, 3, 4, 5]) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;

    const accountId = data.readBigUInt64LE(base + ACCT_ACCOUNT_ID_OFF);
    const capital = readU128LE(data, base + ACCT_CAPITAL_OFF);
    const kind = data.readUInt8(base + ACCT_KIND_OFF);
    const pnl = readI128LE(data, base + ACCT_PNL_OFF);
    const positionSize = readI128LE(data, base + ACCT_POSITION_SIZE_OFF);
    const entryPrice = data.readBigUInt64LE(base + ACCT_ENTRY_PRICE_OFF);

    console.log(`Index ${idx}:`);
    console.log(`  accountId: ${accountId}`);
    console.log(`  capital: ${(Number(capital) / 1e9).toFixed(4)} SOL`);
    console.log(`  kind: ${kind === 0 ? 'User' : kind === 1 ? 'LP' : `Unknown(${kind})`}`);
    console.log(`  pnl: ${pnl.toString()} (${(Number(pnl) / 1e9).toFixed(4)} SOL)`);
    console.log(`  position_size: ${positionSize.toString()} (${(Number(positionSize) / 1e9).toFixed(4)} units)`);
    console.log(`  entry_price: ${entryPrice}`);

    // Check if liquidatable
    if (positionSize !== 0n) {
      const oraclePrice = 7030n;  // Approximate
      const markPnl = positionSize * (oraclePrice - entryPrice);
      const equity = capital + BigInt(pnl) + markPnl / 1000000n;  // price in e6
      const maintReq = (positionSize < 0n ? -positionSize : positionSize) * oraclePrice / 1000000n * 500n / 10000n;
      console.log(`  mark_pnl (est): ${(Number(markPnl) / 1e15).toFixed(4)} SOL`);
      console.log(`  equity (est): ${(Number(equity) / 1e9).toFixed(4)} SOL`);
      console.log(`  maint_req (est): ${(Number(maintReq) / 1e9).toFixed(4)} SOL`);
      console.log(`  LIQUIDATABLE: ${equity < maintReq}`);
    } else {
      console.log(`  No position`);
    }
    console.log();
  }
}

main().catch(console.error);
