import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseParams } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  console.log("=== Risk Parameters ===\n");
  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance fund:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("");
  console.log("RiskParams:");
  console.log("  Warmup period slots:", params.warmupPeriodSlots.toString());
  console.log("  Maintenance margin BPS:", params.maintenanceMarginBps.toString());
  console.log("  Initial margin BPS:", params.initialMarginBps.toString());
  console.log("  Trading fee BPS:", params.tradingFeeBps.toString());
  console.log("  Max accounts:", params.maxAccounts.toString());
  console.log("  New account fee:", Number(params.newAccountFee) / 1e9, "SOL");
  console.log("  Risk reduction threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("  Maintenance fee/slot:", params.maintenanceFeePerSlot.toString());
  console.log("  Max crank staleness:", params.maxCrankStalenessSlots.toString());
  console.log("  Liquidation fee BPS:", params.liquidationFeeBps.toString());
  console.log("");
  console.log("Insurance fund surplus:", Number(engine.insuranceFund.balance) / 1e9 - Number(params.riskReductionThreshold) / 1e9, "SOL");
}

main();
