/**
 * Security Audit: Balance Check
 *
 * Check all account balances and verify solvency
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchSlab, parseConfig, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  const engine = parseEngine(data);

  // Check user's token account
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
  const userAtaInfo = await conn.getTokenAccountBalance(userAta);

  console.log("=== BALANCE CHECK ===");
  console.log("Vault balance:", vaultInfo ? (vaultInfo.lamports / 1e9).toFixed(9) : "N/A", "SOL");
  console.log("User wrapped SOL:", userAtaInfo.value.uiAmount, "SOL");
  console.log("Insurance fund:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");

  // Check all accounts
  const indices = parseUsedIndices(data);
  let totalCapital = 0n;
  let totalPnl = 0n;

  console.log("\n=== ALL ACCOUNTS ===");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;
    const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
    const owner = acc.owner.toBase58().slice(0, 8);
    const isPayer = acc.owner.equals(payer.publicKey) ? " (MINE)" : "";
    const capital = Number(acc.capital) / 1e9;
    const pnl = Number(acc.pnl) / 1e9;
    totalCapital += acc.capital;
    totalPnl += acc.pnl;
    console.log(`  [${idx}] ${kind} owner:${owner}${isPayer} capital:${capital.toFixed(6)} pnl:${pnl.toFixed(6)} pos:${acc.positionSize.toString()}`);
  }

  console.log("\n=== TOTALS ===");
  console.log("Total capital:", (Number(totalCapital) / 1e9).toFixed(9), "SOL");
  console.log("Total PnL:", (Number(totalPnl) / 1e9).toFixed(9), "SOL");
  console.log("Insurance:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(9), "SOL");
  const sumLiabilities = Number(totalCapital + totalPnl) / 1e9 + Number(engine.insuranceFund.balance) / 1e9;
  console.log("Sum liabilities:", sumLiabilities.toFixed(9), "SOL");
  console.log("Vault:", vaultInfo ? (vaultInfo.lamports / 1e9).toFixed(9) : "N/A", "SOL");

  if (vaultInfo) {
    const vaultSol = vaultInfo.lamports / 1e9;
    if (vaultSol >= sumLiabilities) {
      console.log("\nSOLVENCY: OK (vault covers all liabilities)");
      console.log("Surplus:", (vaultSol - sumLiabilities).toFixed(9), "SOL");
    } else {
      console.log("\nSOLVENCY: DEFICIT");
      console.log("Shortfall:", (sumLiabilities - vaultSol).toFixed(9), "SOL");
    }
  }

  // Check my accounts specifically
  console.log("\n=== MY ACCOUNTS DETAIL ===");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc || !acc.owner.equals(payer.publicKey)) continue;

    const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
    console.log(`\nAccount ${idx} (${kind}):`);
    console.log(`  Capital: ${(Number(acc.capital) / 1e9).toFixed(9)} SOL`);
    console.log(`  PnL: ${(Number(acc.pnl) / 1e9).toFixed(9)} SOL`);
    console.log(`  Reserved PnL: ${(Number(acc.reservedPnl) / 1e9).toFixed(9)} SOL`);
    console.log(`  Position Size: ${acc.positionSize.toString()}`);
    console.log(`  Entry Price E6: ${acc.entryPriceE6?.toString() || 'N/A'}`);
    console.log(`  Funding Index: ${acc.fundingIndex?.toString() || 'N/A'}`);
    console.log(`  Warmup Started: ${acc.warmupStartedAtSlot?.toString() || 'N/A'}`);

    // Calculate what should be withdrawable
    const effectiveCapital = Number(acc.capital) + Number(acc.pnl);
    console.log(`  Effective (capital + pnl): ${(effectiveCapital / 1e9).toFixed(9)} SOL`);
  }
}

main().catch(console.error);
