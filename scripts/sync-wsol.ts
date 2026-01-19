import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { syncNative, getAccount, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";

const ATA = new PublicKey("7PTXsfTKCpQHPKZTsU1Mrdb3bwtExDeJGUmkaqkEbCrb");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function main() {
  console.log("Syncing native SOL...");
  
  // Check before
  const before = await getAccount(conn, ATA);
  console.log("Balance before:", Number(before.amount) / 1e9, "wSOL");
  
  // Sync native
  const sig = await syncNative(conn, payer, ATA);
  console.log("Synced:", sig.slice(0, 20) + "...");
  
  // Check after
  const after = await getAccount(conn, ATA);
  console.log("Balance after:", Number(after.amount) / 1e9, "wSOL");
}

main().catch(console.error);
