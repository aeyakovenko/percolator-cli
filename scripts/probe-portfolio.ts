/**
 * Quick probe: dump raw bytes of a portfolio account to figure out which
 * offsets actually hold capital/pnl after a deposit + trades.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { PA, PORTFOLIO_STATE_OFF, HEADER_LEN } from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

const PORT = new PublicKey(process.argv[2]);

async function main() {
  const info = await conn.getAccountInfo(PORT, "confirmed");
  if (!info) throw new Error("not found");
  const d = info.data;
  console.log(`portfolio: ${PORT.toBase58()}  len=${d.length}  owner=${info.owner.toBase58()}`);
  console.log("\nFirst 256 bytes (hex):");
  for (let i = 0; i < 256; i += 32) {
    let hex = "";
    for (let j = 0; j < 32 && i + j < d.length; j++) {
      hex += d[i + j].toString(16).padStart(2, "0") + " ";
    }
    console.log(`  ${i.toString().padStart(4, "0")}: ${hex}`);
  }
  const rd128 = (off: number) => d.readBigUInt64LE(off) | (d.readBigUInt64LE(off + 8) << 64n);
  console.log("\nField reads:");
  console.log(`  HEADER_LEN=${HEADER_LEN} PORTFOLIO_STATE_OFF=${PORTFOLIO_STATE_OFF} PA.capital=${PA.capital}`);
  // Try multiple candidate offsets:
  for (const [label, off] of [
    ["raw 100 (owner start)", 100],
    ["raw 132 (capital@struct)", 132],
    ["raw 148 (capital@struct+HEADER)", 148],
    ["raw 164 (pnl@struct+HEADER)", 164],
    ["raw 180 (reserved_pnl@struct+HEADER)", 180],
  ] as const) {
    console.log(`  ${label.padEnd(40)} = ${rd128(off)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
