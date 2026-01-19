import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const slot = await conn.getSlot();
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);

  console.log("Current slot:", slot);
  console.log("Last crank slot:", engine.lastCrankSlot);
  console.log("Slots since crank:", slot - Number(engine.lastCrankSlot));
  console.log("Max crank staleness:", engine.maxCrankStalenessSlots);
  console.log("");
  console.log("Last sweep start slot:", engine.lastSweepStartSlot);
  console.log("Slots since sweep start:", slot - Number(engine.lastSweepStartSlot));
  console.log("Last sweep complete slot:", engine.lastSweepCompleteSlot);
  console.log("Crank step:", engine.crankStep);
  console.log("");
  console.log("Risk reduction only:", engine.riskReductionOnly);
  console.log("Warmup paused:", engine.warmupPaused);

  // Check if sweep is stale
  if (slot - Number(engine.lastSweepStartSlot) > Number(engine.maxCrankStalenessSlots)) {
    console.log("\n⚠️ SWEEP IS STALE! Risk-increasing trades will be rejected.");
  } else {
    console.log("\n✓ Sweep is fresh.");
  }
}

main();
