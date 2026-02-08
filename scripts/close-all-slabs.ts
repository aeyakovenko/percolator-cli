/**
 * Close ALL accounts owned by the percolator program to reclaim SOL.
 * Requires program deployed with unsafe_close feature.
 * Usage: SOLANA_RPC_URL=... npx tsx scripts/close-all-slabs.ts
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import { encodeCloseSlab } from "../src/abi/instructions.js";
import { ACCOUNTS_CLOSE_SLAB, buildAccountMetas } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";

const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("Fetching all program accounts...");
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
  });

  console.log(`Found ${accounts.length} accounts to close`);
  const totalSol = accounts.reduce((sum, a) => sum + a.account.lamports, 0) / 1e9;
  console.log(`Total SOL to reclaim: ${totalSol.toFixed(2)} SOL`);

  const startBal = await conn.getBalance(payer.publicKey);
  console.log(`Starting balance: ${startBal / 1e9} SOL\n`);

  let closed = 0;
  let failed = 0;

  for (const { pubkey } of accounts) {
    const data = encodeCloseSlab();
    const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [payer.publicKey, pubkey]);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    try {
      await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      closed++;
      if (closed % 10 === 0) {
        const bal = await conn.getBalance(payer.publicKey);
        console.log(`  [${closed}/${accounts.length}] closed, balance: ${bal / 1e9} SOL`);
      }
    } catch (e: any) {
      failed++;
      console.log(`  FAILED ${pubkey.toBase58()}: ${e.message?.slice(0, 80)}`);
    }

    // Small delay to avoid rate limits
    await delay(200);
  }

  const finalBal = await conn.getBalance(payer.publicKey);
  console.log(`\nDone! Closed: ${closed}, Failed: ${failed}`);
  console.log(`Final balance: ${finalBal / 1e9} SOL`);
  console.log(`Reclaimed: ${(finalBal - startBal) / 1e9} SOL`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
