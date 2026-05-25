/**
 * Close admin's wSOL ATA on mainnet, returning the wrapped SOL to native.
 */
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, createCloseAccountInstruction, NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";

const HELIUS = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

async function main() {
  console.log("admin:", admin.publicKey.toBase58());
  const balBefore = await conn.getBalance(admin.publicKey);
  console.log(`pre  native: ${balBefore/1e9} SOL`);
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, admin.publicKey);
  const ataInfo = await conn.getAccountInfo(ata);
  if (!ataInfo) { console.log("ATA does not exist."); return; }
  const bal = await conn.getTokenAccountBalance(ata);
  console.log(`ATA: ${ata.toBase58()}  ${bal.value.uiAmount} wSOL  (rent ${ataInfo.lamports/1e9} SOL)`);
  const tx = new Transaction().add(createCloseAccountInstruction(ata, admin.publicKey, admin.publicKey));
  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
  console.log("close tx:", sig);
  const balAfter = await conn.getBalance(admin.publicKey);
  console.log(`post native: ${balAfter/1e9} SOL  (+${(balAfter-balBefore)/1e9} SOL)`);
}
main().catch(e => { console.error(e); process.exit(1); });
