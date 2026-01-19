import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

// Engine offsets (from slab.ts)
const ENGINE_OFF = 328;
const PARAMS_OFF = 176; // params start within engine
const PARAMS_RISK_THRESHOLD_OFF = 56;
const PARAMS_MAINTENANCE_MARGIN_OFF = 8;
const PARAMS_INITIAL_MARGIN_OFF = 16;
const PARAMS_TRADING_FEE_OFF = 24;

function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return lo + (hi << 64n);
}

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);

  const paramsBase = ENGINE_OFF + PARAMS_OFF;

  console.log("=== Risk Parameters (detailed) ===\n");
  console.log("Engine offset:", ENGINE_OFF);
  console.log("Params offset:", paramsBase);
  console.log("");

  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance fund:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("");

  // Read params directly
  const maintenanceMargin = data.readBigUInt64LE(paramsBase + PARAMS_MAINTENANCE_MARGIN_OFF);
  const initialMargin = data.readBigUInt64LE(paramsBase + PARAMS_INITIAL_MARGIN_OFF);
  const tradingFee = data.readBigUInt64LE(paramsBase + PARAMS_TRADING_FEE_OFF);
  const riskThreshold = readU128LE(data, paramsBase + PARAMS_RISK_THRESHOLD_OFF);

  console.log("Risk params:");
  console.log("  Maintenance margin BPS:", maintenanceMargin.toString());
  console.log("  Initial margin BPS:", initialMargin.toString());
  console.log("  Trading fee BPS:", tradingFee.toString());
  console.log("  Risk reduction threshold:", Number(riskThreshold) / 1e9, "SOL");
  console.log("");
  console.log("Risk reduction mode:", engine.riskReductionOnly);
  console.log("Warmup paused:", engine.warmupPaused);
}

main();
