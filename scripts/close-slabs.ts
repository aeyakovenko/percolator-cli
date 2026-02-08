/**
 * Close dead slab accounts to reclaim SOL rent.
 * Usage: SOLANA_RPC_URL=... npx tsx scripts/close-slabs.ts <slab1> [slab2] ...
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

async function closeSlab(slabPubkey: PublicKey) {
  const info = await conn.getAccountInfo(slabPubkey);
  if (!info) {
    console.log(`  ${slabPubkey.toBase58()}: account not found, skipping`);
    return;
  }
  console.log(`  ${slabPubkey.toBase58()}: ${info.lamports / 1e9} SOL, owner=${info.owner.toBase58()}`);

  const data = encodeCloseSlab();
  const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [payer.publicKey, slabPubkey]);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  CLOSED: ${sig}`);
  } catch (e: any) {
    console.log(`  FAILED: ${e.message?.slice(0, 100)}`);
    if (e.logs) console.log(`  Logs: ${JSON.stringify(e.logs)}`);
  }
}

async function main() {
  const slabs = process.argv.slice(2);
  if (slabs.length === 0) {
    console.log("Usage: npx tsx scripts/close-slabs.ts <slab1> [slab2] ...");
    process.exit(1);
  }

  console.log(`Closing ${slabs.length} slab(s)...`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`Balance: ${bal / 1e9} SOL\n`);

  for (const s of slabs) {
    await closeSlab(new PublicKey(s));
  }

  const finalBal = await conn.getBalance(payer.publicKey);
  console.log(`\nFinal balance: ${finalBal / 1e9} SOL`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
