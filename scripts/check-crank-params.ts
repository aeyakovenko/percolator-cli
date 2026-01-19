import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);

  // Get current slot
  const slot = await conn.getSlot();

  console.log("Current slot:", slot);
  console.log("Last crank slot:", engine.lastCrankSlot);
  console.log("Slots since crank:", slot - Number(engine.lastCrankSlot));
  console.log("Max crank staleness:", engine.maxCrankStalenessSlots);
  console.log("Last full sweep start slot:", engine.lastFullSweepStartSlot);
  console.log("Slots since sweep:", slot - Number(engine.lastFullSweepStartSlot));

  if (slot - Number(engine.lastCrankSlot) > engine.maxCrankStalenessSlots) {
    console.log("\n⚠️ CRANK IS STALE! Trades will be rejected.");
  } else {
    console.log("\n✓ Crank is fresh.");
  }
}

main();
