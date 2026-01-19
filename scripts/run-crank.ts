import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseEngine } from "../src/solana/slab.js";
import fs from "fs";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const ORACLE = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function runCrank(): Promise<string> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  return await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
}

async function main() {
  console.log("Running keeper crank loop...\n");

  // Run 10 crank iterations
  for (let i = 0; i < 10; i++) {
    try {
      const sig = await runCrank();
      console.log("Crank " + (i + 1) + ": " + sig.slice(0, 20) + "...");
    } catch (err) {
      console.log("Crank " + (i + 1) + " error:", (err as any).message?.slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Check state
  const slot = await conn.getSlot();
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);

  console.log("\nFinal state:");
  console.log("  Current slot:", slot);
  console.log("  Last crank slot:", engine.lastCrankSlot);
  console.log("  Slots since crank:", slot - Number(engine.lastCrankSlot));
  console.log("  Max crank staleness:", engine.maxCrankStalenessSlots);

  if (slot - Number(engine.lastCrankSlot) > engine.maxCrankStalenessSlots) {
    console.log("  ⚠️ STILL STALE!");
  } else {
    console.log("  ✓ Crank is now fresh!");
  }
}

main();
