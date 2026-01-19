import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { fetchSlab } from "../src/solana/slab.js";
import fs from "fs";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

// Account struct size: 232 bytes
// owner offset in account struct: 0 (first 32 bytes)
const ACCOUNT_SIZE = 232;
const ENGINE_START = 32; // First 32 bytes are magic/version
const ACCOUNTS_START = ENGINE_START + 1024; // Engine header is 1024 bytes (approximate, may need adjustment)

async function main() {
  console.log("Payer pubkey:", payer.publicKey.toBase58());
  console.log("Payer bytes:", Buffer.from(payer.publicKey.toBytes()).toString('hex'));
  
  const data = await fetchSlab(conn, SLAB);
  console.log("\nSlab data length:", data.length);

  // Check accounts at indices 0 and 6
  for (const idx of [0, 6]) {
    // Need to find the correct offset for account data
    // Let's use the slab parser to get the account offset
    const acc = await import('../src/solana/slab.js').then(m => m.parseAccount(data, idx));
    console.log("\nAccount " + idx + ":");
    console.log("  Parsed owner:", acc.owner.toBase58());
    console.log("  Parsed capital:", Number(acc.capital) / 1e9, "SOL");
    console.log("  Owner matches payer:", acc.owner.equals(payer.publicKey));
  }
}

main();
