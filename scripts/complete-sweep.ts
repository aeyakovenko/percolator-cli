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
  console.log("Running crank loop until sweep completes...\n");

  let lastStep = -1;
  let sweepStartSlot = 0n;
  let iterations = 0;
  const maxIterations = 30;

  while (iterations < maxIterations) {
    iterations++;
    try {
      const sig = await runCrank();
      
      const data = await fetchSlab(conn, SLAB);
      const engine = parseEngine(data);
      const slot = await conn.getSlot();

      console.log("Crank " + iterations + ": step=" + engine.crankStep + 
                  ", sweepStart=" + engine.lastSweepStartSlot + 
                  ", staleness=" + (slot - Number(engine.lastSweepStartSlot)));

      // If sweep started fresh (within staleness window), we're good
      if (slot - Number(engine.lastSweepStartSlot) <= Number(engine.maxCrankStalenessSlots)) {
        console.log("\n✓ Sweep is now fresh!");
        break;
      }

      // If step is 0 and we've started a new sweep cycle
      if (engine.crankStep === 0 && Number(engine.lastSweepStartSlot) > sweepStartSlot) {
        sweepStartSlot = engine.lastSweepStartSlot;
        console.log("New sweep started at slot", sweepStartSlot.toString());
      }
    } catch (err) {
      console.log("Crank " + iterations + " error:", (err as any).message?.slice(0, 50));
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Final check
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const slot = await conn.getSlot();

  console.log("\nFinal state:");
  console.log("  Current slot:", slot);
  console.log("  Last sweep start:", engine.lastSweepStartSlot);
  console.log("  Staleness:", slot - Number(engine.lastSweepStartSlot));
  console.log("  Max staleness:", engine.maxCrankStalenessSlots);
  console.log("  Crank step:", engine.crankStep);
}

main();
