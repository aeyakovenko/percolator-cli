import { Connection, PublicKey } from "@solana/web3.js";
import { parseUsedIndices } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");

const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;
const ACCT_PNL_OFF = 32;
const ACCT_CAPITAL_OFF = 8;
const ACCT_POSITION_SIZE_OFF = 80;

function readI128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigInt64LE(off + 8);
  return lo + (hi << 64n);
}

function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return lo + (hi << 64n);
}

async function main() {
  const info = await conn.getAccountInfo(SLAB);
  const data = Buffer.from(info!.data);

  const indices = parseUsedIndices(data);

  for (const idx of indices) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    const rawPnl = data.subarray(base + ACCT_PNL_OFF, base + ACCT_PNL_OFF + 16);
    const rawCapital = data.subarray(base + ACCT_CAPITAL_OFF, base + ACCT_CAPITAL_OFF + 16);
    const rawPosition = data.subarray(base + ACCT_POSITION_SIZE_OFF, base + ACCT_POSITION_SIZE_OFF + 16);

    const pnl = readI128LE(data, base + ACCT_PNL_OFF);
    const capital = readU128LE(data, base + ACCT_CAPITAL_OFF);
    const position = readI128LE(data, base + ACCT_POSITION_SIZE_OFF);

    console.log(`Account ${idx}:`);
    console.log(`  Raw PnL hex: ${rawPnl.toString("hex")}`);
    console.log(`  PnL i128: ${pnl} (${Number(pnl) / 1e9} SOL)`);
    console.log(`  Raw Capital hex: ${rawCapital.toString("hex")}`);
    console.log(`  Capital: ${capital} (${Number(capital) / 1e9} SOL)`);
    console.log(`  Position: ${position}`);
    console.log();
  }
}

main();
