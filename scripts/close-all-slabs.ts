/**
 * DEVNET ONLY: drain all accounts owned by the percolator program.
 *
 * Requires the program is built+deployed with the `unsafe_close` feature,
 * which collapses CloseSlab to a 2-account [dest, slab] lamport sweep
 * with no validation. Build:
 *
 *   cd ~/percolator-prog && cargo build-sbf --features unsafe_close
 *   solana program deploy target/deploy/percolator_prog.so \
 *     --program-id <ID> --url devnet
 *
 * Usage: SOLANA_RPC_URL=... npx tsx scripts/close-all-slabs.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import { encodeCloseSlab } from "../src/abi/instructions.js";
import { buildIx } from "../src/runtime/tx.js";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s"
);
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Payer:   ${payer.publicKey.toBase58()}\n`);
  console.log("Fetching all program accounts...");
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
  });

  console.log(`Found ${accounts.length} accounts to close`);
  const totalSol = accounts.reduce((sum, a) => sum + a.account.lamports, 0) / 1e9;
  console.log(`Total SOL to reclaim: ${totalSol.toFixed(4)} SOL`);

  const startBal = await conn.getBalance(payer.publicKey);
  console.log(`Starting balance: ${(startBal / 1e9).toFixed(4)} SOL\n`);

  let closed = 0;
  let failed = 0;

  for (const { pubkey, account } of accounts) {
    const data = encodeCloseSlab();
    // unsafe_close path: 2 accounts only — [dest (signer, writable), slab (writable)]
    const keys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey, isSigner: false, isWritable: true },
    ];
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    try {
      await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      closed++;
      const recovered = (account.lamports / 1e9).toFixed(4);
      console.log(`  [${closed}/${accounts.length}] ${pubkey.toBase58().slice(0, 12)}… (+${recovered} SOL)`);
    } catch (e: any) {
      failed++;
      console.log(`  FAILED ${pubkey.toBase58()}: ${e.message?.slice(0, 100)}`);
    }
    await delay(150);
  }

  const finalBal = await conn.getBalance(payer.publicKey);
  console.log(`\nDone! Closed: ${closed}, Failed: ${failed}`);
  console.log(`Final balance: ${(finalBal / 1e9).toFixed(4)} SOL`);
  console.log(`Reclaimed:     ${((finalBal - startBal) / 1e9).toFixed(4)} SOL`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
