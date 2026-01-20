/**
 * Analyze what happened with the insurance fund drain
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, parseParams, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  console.log("=== INSURANCE FUND DRAIN ANALYSIS ===\n");

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  const vaultBalance = vaultInfo ? vaultInfo.lamports / 1e9 : 0;

  console.log("=== Timeline of Events ===");
  console.log("Before test:");
  console.log("  - Vault: ~3.809 SOL");
  console.log("  - Insurance: ~1.011 SOL");
  console.log("  - LP capital: 0 SOL");
  console.log("");
  console.log("Event 1 - LP Funded:");
  console.log("  - Vault: +1 SOL (fund-lp-for-testing.ts deposited)");
  console.log("  - LP capital: +1 SOL");
  console.log("");
  console.log("Event 2 - Liquidation Test:");
  console.log("  - Opened LONG position at $150");
  console.log("  - Crashed price to trigger liquidation");
  console.log("  - 1 liquidation recorded");
  console.log("");
  console.log("Event 3 - Insurance Drained:");
  console.log("  - Insurance: 1.011 SOL -> 0.0003 SOL");
  console.log("  - This happened during 'extreme prices' attack iteration");

  console.log("\n=== Current State ===");
  console.log("Vault Balance:", vaultBalance.toFixed(9), "SOL");
  console.log("Insurance Fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");
  console.log("Insurance Fee Revenue:", (Number(engine.insuranceFund.feeRevenue) / 1e9).toFixed(9), "SOL");
  console.log("Lifetime Liquidations:", Number(engine.lifetimeLiquidations));
  console.log("Lifetime Force Closes:", Number(engine.lifetimeForceCloses));
  console.log("Risk Reduction Mode:", engine.riskReductionOnly);
  console.log("Loss Accumulator:", (Number(engine.lossAccum) / 1e9).toFixed(9), "SOL");
  console.log("Warmup Insurance Reserved:", (Number(engine.warmupInsuranceReserved) / 1e9).toFixed(9), "SOL");

  console.log("\n=== Account Details ===");
  const indices = parseUsedIndices(data);
  let totalCapital = 0n;
  let totalPnl = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      const capital = acc.capital;
      totalCapital += capital;

      // Handle pnl
      let pnl = acc.pnl;
      if (pnl > 9_000_000_000_000_000_000n) {
        pnl = pnl - 18446744073709551616n;
      }
      totalPnl += pnl;

      console.log(`\n[${idx}] ${kind}:`);
      console.log(`  Capital: ${(Number(capital) / 1e9).toFixed(9)} SOL`);
      console.log(`  PnL: ${(Number(pnl) / 1e9).toFixed(9)} SOL`);
      console.log(`  Position: ${acc.positionSize} units`);
      console.log(`  Entry Price: ${Number(acc.entryPrice) / 1e6} USD`);
      console.log(`  Funding Index: ${Number(acc.fundingIndex)}`);
      console.log(`  Owner: ${acc.owner.toBase58()}`);
    }
  }

  console.log("\n=== Solvency Analysis ===");
  console.log("Total Capital:", (Number(totalCapital) / 1e9).toFixed(9), "SOL");
  console.log("Total PnL:", (Number(totalPnl) / 1e9).toFixed(9), "SOL");
  console.log("Insurance Fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");

  const totalLiabilities = Number(totalCapital + totalPnl + engine.insuranceFund.balance) / 1e9;
  console.log("Total Liabilities:", totalLiabilities.toFixed(9), "SOL");
  console.log("Vault Balance:", vaultBalance.toFixed(9), "SOL");
  console.log("Surplus/Deficit:", (vaultBalance - totalLiabilities).toFixed(9), "SOL");

  console.log("\n=== Security Analysis ===");
  console.log("The insurance fund drain (~1.01 SOL) could indicate:");
  console.log("1. BAD DEBT - A position was liquidated with losses exceeding capital");
  console.log("   (Insurance correctly covered the shortfall)");
  console.log("2. EXPLOIT - Insurance was improperly drained");
  console.log("");
  console.log("Key question: Was the bad debt creation legitimate?");
  console.log("");
  console.log("If LP capital was 0 before funding, and 1 SOL was added,");
  console.log("and insurance drained 1.01 SOL, then total 'loss' was ~1 SOL");
  console.log("which matches the LP funding. This suggests the test user");
  console.log("extracted ~1 SOL profit which was paid by LP and insurance.");

  console.log("\n=== Verification Needed ===");
  console.log("Check: Did the user successfully withdraw any funds?");
  console.log("Check: What was the user's capital change?");
  console.log("Check: Was this legitimate (user realized actual losses)?");

  // Check if vault has more than it should
  console.log("\n=== Vault Excess Check ===");
  const expectedVault = totalLiabilities;
  const excess = vaultBalance - expectedVault;
  console.log("Expected vault (liabilities):", expectedVault.toFixed(9), "SOL");
  console.log("Actual vault:", vaultBalance.toFixed(9), "SOL");
  console.log("Excess:", excess.toFixed(9), "SOL");

  if (excess > 0.1) {
    console.log("\n*** SIGNIFICANT EXCESS - This means someone's PnL hasn't been withdrawn ***");
    console.log("*** This is the security mechanism - user profits but can't withdraw ***");
  }
}

main().catch(console.error);
