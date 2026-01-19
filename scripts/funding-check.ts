import { Connection, PublicKey } from "@solana/web3.js";
import { parseUsedIndices, parseEngine } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");

const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;

// Account offsets
const ACCT_PNL_OFF = 32;
const ACCT_POSITION_SIZE_OFF = 80;
const ACCT_FUNDING_INDEX_OFF = 104;

function readI128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned & SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

async function main() {
  const info = await conn.getAccountInfo(SLAB);
  const data = Buffer.from(info!.data);

  const engine = parseEngine(data);
  const globalFundingIndex = engine.fundingIndexQpbE6;

  console.log(`Global Funding Index: ${globalFundingIndex}`);
  console.log();

  const indices = parseUsedIndices(data);

  for (const idx of indices) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;

    const pnl = readI128LE(data, base + ACCT_PNL_OFF);
    const position = readI128LE(data, base + ACCT_POSITION_SIZE_OFF);
    const fundingIdx = readI128LE(data, base + ACCT_FUNDING_INDEX_OFF);

    const deltaF = globalFundingIndex - fundingIdx;

    // Unsettled funding payment
    let unsettledPayment = 0n;
    if (position !== 0n && deltaF !== 0n) {
      const raw = position * deltaF;
      unsettledPayment = raw / 1_000_000n;
    }

    console.log(`Account ${idx}:`);
    console.log(`  Position: ${position}`);
    console.log(`  PnL: ${pnl} (${Number(pnl) / 1e9} SOL)`);
    console.log(`  Account Funding Index: ${fundingIdx}`);
    console.log(`  Delta F: ${deltaF}`);
    console.log(`  Unsettled Funding Payment: ${unsettledPayment} (${Number(unsettledPayment) / 1e9} SOL)`);
    console.log(`  PnL if settled: ${pnl - unsettledPayment}`);
    console.log();
  }
}

main();
