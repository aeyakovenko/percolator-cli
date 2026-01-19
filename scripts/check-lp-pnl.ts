import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  console.log("=== All Account States ===\n");
  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("");

  let totalPosPnL = 0n;
  let totalNegPnL = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    const type = isLP ? "LP" : "USER";
    const dir = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";

    if (acc.positionSize !== 0n || isLP) {
      console.log(type + " " + idx + ":");
      console.log("  Position:", acc.positionSize.toString(), "(" + dir + ")");
      console.log("  Capital:", Number(acc.capital) / 1e9, "SOL");
      console.log("  PnL:", Number(acc.pnl) / 1e9, "SOL");
      console.log("  Entry price:", acc.entryPrice?.toString() || "N/A");
      console.log("");

      if (acc.pnl > 0n) totalPosPnL += acc.pnl;
      if (acc.pnl < 0n) totalNegPnL += acc.pnl;
    }
  }

  console.log("Total positive PnL:", Number(totalPosPnL) / 1e9, "SOL");
  console.log("Total negative PnL:", Number(totalNegPnL) / 1e9, "SOL");
  console.log("Net PnL:", Number(totalPosPnL + totalNegPnL) / 1e9, "SOL");
}

main();
