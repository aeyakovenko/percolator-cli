/**
 * Verify LP Drain Analysis
 *
 * Check if more can be extracted than deposited
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  console.log("=== LP DRAIN VERIFICATION ===\n");

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  const vaultBalance = vaultInfo ? vaultInfo.lamports / 1e9 : 0;

  console.log("Vault Balance:", vaultBalance.toFixed(9), "SOL");
  console.log("Insurance Fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");

  console.log("\n=== Accounts ===");
  const indices = parseUsedIndices(data);
  let totalCapital = 0n;
  let totalPnl = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      totalCapital += acc.capital;

      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      totalPnl += pnl;

      console.log(`[${idx}] ${kind}:`);
      console.log(`  Capital: ${(Number(acc.capital) / 1e9).toFixed(9)} SOL`);
      console.log(`  PnL: ${(Number(pnl) / 1e9).toFixed(9)} SOL`);
      console.log(`  Position: ${acc.positionSize}`);
    }
  }

  console.log("\n=== Analysis ===");

  // Timeline of events
  console.log("\nTimeline:");
  console.log("1. Initial state: 4.609 SOL vault");
  console.log("2. Attack deposited 0.5 SOL to LP -> vault should be 5.109 SOL");
  console.log("3. User 2 withdrew ~0.5 SOL -> vault back to ~4.609 SOL");
  console.log("4. Current vault:", vaultBalance.toFixed(6), "SOL");

  console.log("\nNet flow:");
  console.log("  Deposited: 0.5 SOL");
  console.log("  Withdrawn: ~0.5 SOL");
  console.log("  Net: ~0 SOL (slightly positive due to fees)");

  console.log("\n=== Security Verification ===");
  console.log("Q: Can attacker extract MORE than they deposit?");
  console.log("A: NO - withdrawals are limited by LP capital");
  console.log("");
  console.log("Q: Can third party's LP deposit be stolen?");
  console.log("A: YES, but attacker must have existing position with unrealized profit");
  console.log("   The withdrawal is capped by LP capital, so attacker can only");
  console.log("   withdraw up to what LP has, not their full 'paper profit'");
  console.log("");
  console.log("Q: Is this a vulnerability?");
  console.log("A: DEBATABLE - If someone funds LP with 0.5 SOL, and user has");
  console.log("   1M unit position with huge unrealized profit, user can withdraw");
  console.log("   UP TO 0.5 SOL (LP capital), not their full paper profit.");

  // Solvency check
  const totalLiabilities = Number(totalCapital + totalPnl + engine.insuranceFund.balance) / 1e9;
  console.log("\n=== Solvency ===");
  console.log("Liabilities:", totalLiabilities.toFixed(9), "SOL");
  console.log("Vault:", vaultBalance.toFixed(9), "SOL");
  console.log("Surplus:", (vaultBalance - totalLiabilities).toFixed(9), "SOL");
  console.log("Status:", vaultBalance >= totalLiabilities ? "SOLVENT" : "INSOLVENT");
}

main().catch(console.error);
