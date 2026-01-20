/**
 * Quick state check after insurance drain
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  const vaultBalance = vaultInfo ? vaultInfo.lamports / 1e9 : 0;

  console.log("=== CURRENT STATE AFTER INSURANCE DRAIN ===\n");
  console.log("Vault Balance:", vaultBalance.toFixed(9), "SOL");
  console.log("Insurance Fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");
  console.log("Lifetime Liquidations:", Number(engine.lifetimeLiquidations));

  console.log("\n=== ACCOUNTS ===");
  const indices = parseUsedIndices(data);
  let totalCapital = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      const capital = Number(acc.capital) / 1e9;
      totalCapital += acc.capital;

      // Handle pnl
      let pnl = acc.pnl;
      if (pnl > 9_000_000_000_000_000_000n) {
        pnl = pnl - 18446744073709551616n;
      }
      const pnlVal = Number(pnl) / 1e9;

      console.log(`[${idx}] ${kind}: capital=${capital.toFixed(6)} pnl=${pnlVal.toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  console.log("\n=== SOLVENCY CHECK ===");
  const totalLiabilities = Number(totalCapital) / 1e9 + Number(engine.insuranceFund.balance) / 1e9;
  console.log("Total Account Capital:", (Number(totalCapital) / 1e9).toFixed(9), "SOL");
  console.log("Insurance Fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");
  console.log("Total Liabilities:", totalLiabilities.toFixed(9), "SOL");
  console.log("Vault Balance:", vaultBalance.toFixed(9), "SOL");
  console.log("Surplus/Deficit:", (vaultBalance - totalLiabilities).toFixed(9), "SOL");
  console.log("Status:", vaultBalance >= totalLiabilities ? "SOLVENT" : "*** INSOLVENT ***");
}

main().catch(console.error);
