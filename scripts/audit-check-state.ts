/**
 * Security Audit: Check current market state
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseParams, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  console.log("=== PERCOLATOR SECURITY AUDIT - STATE CHECK ===\n");

  const data = await fetchSlab(conn, SLAB);
  const header = parseHeader(data);
  const config = parseConfig(data);
  const engine = parseEngine(data);
  const params = parseParams(data);

  console.log("=== MARKET CONFIGURATION ===");
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Admin: ${header.admin.toBase58()}`);
  console.log(`Inverted: ${config.invert === 1}`);

  console.log("\n=== ORACLE AUTHORITY ===");
  console.log(`Authority: ${config.oracleAuthority.toBase58()}`);
  console.log(`Authority Price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(6)}`);
  console.log(`Authority Timestamp: ${config.authorityTimestamp.toString()}`);
  const isAuthoritySet = !config.oracleAuthority.equals(PublicKey.default);
  console.log(`Authority Active: ${isAuthoritySet}`);

  console.log("\n=== RISK PARAMETERS ===");
  console.log(`Maintenance Margin: ${params.maintenanceMarginBps} bps (${Number(params.maintenanceMarginBps) / 100}%)`);
  console.log(`Initial Margin: ${params.initialMarginBps} bps`);
  console.log(`Trading Fee: ${params.tradingFeeBps} bps`);
  console.log(`Liquidation Fee: ${params.liquidationFeeBps} bps`);

  console.log("\n=== ENGINE STATE ===");
  const insuranceSol = Number(engine.insuranceFund.balance) / 1e9;
  console.log(`Insurance Fund: ${insuranceSol.toFixed(9)} SOL`);
  console.log(`Net LP Position: ${engine.netLpPos.toString()}`);
  console.log(`Risk Reduction Only: ${engine.riskReductionOnly}`);
  console.log(`Lifetime Liquidations: ${engine.lifetimeLiquidations.toString()}`);
  console.log(`Lifetime Force Closes: ${engine.lifetimeForceCloses.toString()}`);
  console.log(`Total Open Interest: ${engine.totalOpenInterest.toString()}`);
  console.log(`Last Crank Slot: ${engine.lastCrankSlot.toString()}`);

  // Get vault balance
  const vaultInfo = await conn.getAccountInfo(new PublicKey(marketInfo.vault));
  const vaultBalance = vaultInfo ? vaultInfo.lamports / 1e9 : 0;
  console.log(`\nVault Balance: ${vaultBalance.toFixed(9)} SOL`);

  // Parse accounts
  const indices = parseUsedIndices(data);
  let totalCapital = 0n;
  let lpCapital = 0n;
  let userCapital = 0n;
  let lpCount = 0;
  let userCount = 0;
  let positionCount = 0;

  console.log("\n=== ACCOUNTS ===");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    totalCapital += acc.capital;
    if (acc.kind === AccountKind.LP) {
      lpCount++;
      lpCapital += acc.capital;
    } else {
      userCount++;
      userCapital += acc.capital;
    }

    if (acc.positionSize !== 0n) {
      positionCount++;
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
      console.log(`  [${idx}] ${kind} ${dir} ${acc.positionSize.toString()} @ entry ${acc.entryPriceE6.toString()}`);
      console.log(`       Capital: ${(Number(acc.capital) / 1e9).toFixed(9)} SOL`);
    }
  }

  console.log(`\nTotal Accounts: ${indices.length} (${lpCount} LPs, ${userCount} Users)`);
  console.log(`Accounts with Positions: ${positionCount}`);
  console.log(`Total Capital (all accounts): ${(Number(totalCapital) / 1e9).toFixed(9)} SOL`);
  console.log(`LP Capital: ${(Number(lpCapital) / 1e9).toFixed(9)} SOL`);
  console.log(`User Capital: ${(Number(userCapital) / 1e9).toFixed(9)} SOL`);

  // Solvency check
  const totalLiability = Number(totalCapital) / 1e9 + insuranceSol;
  console.log("\n=== SOLVENCY CHECK ===");
  console.log(`Vault Balance: ${vaultBalance.toFixed(9)} SOL`);
  console.log(`Total Liability (capital + insurance): ${totalLiability.toFixed(9)} SOL`);
  console.log(`Solvency: ${vaultBalance >= totalLiability ? "SOLVENT" : "INSOLVENT"}`);
  if (vaultBalance < totalLiability) {
    console.log(`DEFICIT: ${(totalLiability - vaultBalance).toFixed(9)} SOL`);
  } else {
    console.log(`SURPLUS: ${(vaultBalance - totalLiability).toFixed(9)} SOL`);
  }

  return {
    inverted: config.invert === 1,
    authoritySet: isAuthoritySet,
    insuranceSol,
    vaultBalance,
    totalCapitalSol: Number(totalCapital) / 1e9,
    positionCount,
    solvent: vaultBalance >= totalLiability
  };
}

main().catch(console.error);
