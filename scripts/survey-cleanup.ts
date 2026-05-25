/**
 * Survey all v16 markets + portfolios owned by the bounty-5 program on devnet.
 * Reports total recoverable rent without taking any destructive action.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import {
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, PORTFOLIO_STATE_OFF, PA,
  KIND_MARKET, KIND_PORTFOLIO,
} from "../src/v16/index.js";
import bs58 from "bs58";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.V16_PROGRAM_ID ?? "Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const ADMIN = new PublicKey("A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK");
const conn = new Connection(RPC, "confirmed");

function headerBytes(kind: number): Buffer {
  const b = Buffer.alloc(11);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(16, 8);
  b.writeUInt8(kind, 10);
  return b;
}
const rd128 = (d: Buffer, off: number) => d.readBigUInt64LE(off) | (d.readBigUInt64LE(off + 8) << 64n);

async function main() {
  console.log("program:", PROGRAM_ID.toBase58());
  console.log("admin:  ", ADMIN.toBase58());

  console.log("\n--- markets ---");
  const markets = await conn.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: MARKET_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: bs58.encode(headerBytes(KIND_MARKET)) } },
    ],
  });
  let mktRent = 0n;
  let totalVault = 0n, totalIns = 0n, totalCtot = 0n;
  for (const { pubkey, account } of markets) {
    const d = Buffer.from(account.data);
    const mode = d[MARKET_GROUP_OFF + MG.mode];
    const vault = rd128(d, MARKET_GROUP_OFF + MG.vault);
    const insurance = rd128(d, MARKET_GROUP_OFF + MG.insurance);
    const cTot = rd128(d, MARKET_GROUP_OFF + MG.c_tot);
    const used = d.readBigUInt64LE(MARKET_GROUP_OFF + MG.materialized_portfolio_count);
    mktRent += BigInt(account.lamports);
    totalVault += vault; totalIns += insurance; totalCtot += cTot;
    console.log(`  ${pubkey.toBase58()}  rent=${(account.lamports/1e9).toFixed(3)}SOL  mode=${mode}  vault=${vault}  ins=${insurance}  cTot=${cTot}  ports=${used}`);
  }
  console.log(`  markets: ${markets.length}  rent locked: ${(Number(mktRent)/1e9).toFixed(3)} SOL`);

  console.log("\n--- portfolios ---");
  const portfolios = await conn.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: PORTFOLIO_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: bs58.encode(headerBytes(KIND_PORTFOLIO)) } },
    ],
  });
  let pfRent = 0n;
  for (const { pubkey, account } of portfolios) {
    const d = Buffer.from(account.data);
    const cap = rd128(d, PORTFOLIO_STATE_OFF + PA.capital);
    pfRent += BigInt(account.lamports);
    console.log(`  ${pubkey.toBase58()}  rent=${(account.lamports/1e9).toFixed(3)}SOL  capital=${cap}`);
  }
  console.log(`  portfolios: ${portfolios.length}  rent locked: ${(Number(pfRent)/1e9).toFixed(3)} SOL`);

  console.log(`\n=== TOTAL recoverable rent: ${(Number(mktRent + pfRent)/1e9).toFixed(3)} SOL ===`);
  console.log(`(vault total ${totalVault}, insurance total ${totalIns}, c_tot total ${totalCtot})`);
}
main().catch(e => { console.error(e); process.exit(1); });
