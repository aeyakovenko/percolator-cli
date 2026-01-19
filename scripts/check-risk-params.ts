import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseConfig } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);

  console.log("=== Risk Parameters ===\n");
  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance fund:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Risk reduction threshold:", Number(engine.riskReductionOnly ? "ACTIVE" : "inactive"));
  console.log("");
  console.log("Config:");
  console.log("  Initial margin BPS:", config.initialMarginBps || "N/A");
  console.log("  Maintenance margin BPS:", config.maintenanceMarginBps || "N/A");
  console.log("  Trading fee BPS:", config.tradingFeeBps || "N/A");
  console.log("");
  console.log("Engine state:");
  console.log("  Total OI:", Number(engine.totalOpenInterest) / 1e9, "units");
  console.log("  Loss accum:", Number(engine.lossAccum) / 1e9, "SOL");
  console.log("  Lifetime liquidations:", engine.lifetimeLiquidations);
  console.log("  Lifetime force closes:", engine.lifetimeForceCloses);
}

main();
