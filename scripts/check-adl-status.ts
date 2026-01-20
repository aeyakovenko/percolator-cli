import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  
  console.log("=== ADL/LIQUIDATION STATUS ===");
  console.log("");
  console.log("Lifetime Force Closes (ADL):", Number(engine.lifetimeForceCloses));
  console.log("Lifetime Liquidations:", Number(engine.lifetimeLiquidations));
  console.log("Insurance Fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(6), "SOL");
  
  console.log("");
  console.log("Accounts with positions:");
  let foundPosition = false;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc && acc.positionSize !== 0n) {
      foundPosition = true;
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      console.log("  [" + idx + "] " + kind + ": pos=" + acc.positionSize + " entry=$" + (Number(acc.entryPrice) / 1e6).toFixed(2) + " capital=" + (Number(acc.capital) / 1e9).toFixed(6));
    }
  }
  if (!foundPosition) {
    console.log("  (none)");
  }
  
  console.log("");
  console.log("=== ADL VERIFICATION ===");
  if (Number(engine.lifetimeForceCloses) > 0) {
    console.log("ADL HAS TRIGGERED:", Number(engine.lifetimeForceCloses), "force close(s) recorded");
    console.log("This proves the ADL mechanism is functional.");
  } else {
    console.log("No ADL events recorded yet.");
  }
  
  if (Number(engine.lifetimeLiquidations) > 0) {
    console.log("LIQUIDATIONS HAVE OCCURRED:", Number(engine.lifetimeLiquidations), "liquidation(s) recorded");
  }
}

main().catch(console.error);
