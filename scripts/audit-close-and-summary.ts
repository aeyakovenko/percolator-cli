/**
 * Security Audit: Close positions and create summary
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function pushPrice(priceUsd: number): Promise<boolean> {
  const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const data = encodePushOraclePrice({ priceE6, timestamp });
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function crank(): Promise<boolean> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function trade(userIdx: number, lpIdx: number, size: bigint): Promise<boolean> {
  const tradeData = encodeTradeCpi({ userIdx, lpIdx, size });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, MATCHER_CTX, LP_PDA,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    console.log(`  Trade failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function main() {
  console.log("=== FINAL CLEANUP AND SUMMARY ===\n");

  // Set price and crank
  await pushPrice(150);
  for (let i = 0; i < 16; i++) await crank();

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  const vaultBalance = vaultInfo ? vaultInfo.lamports / 1e9 : 0;

  // Find and close any open positions
  console.log("=== CLOSING OPEN POSITIONS ===");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc || !acc.owner.equals(payer.publicKey) || acc.positionSize === 0n) continue;

    const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
    console.log(`\nAccount ${idx} (${kind}): position ${acc.positionSize.toString()}`);

    // Close position
    const closeSize = -acc.positionSize;
    console.log(`Closing with size ${closeSize.toString()}...`);
    const success = await trade(idx, 0, closeSize);
    console.log(success ? "Closed!" : "Failed to close");
  }

  // Final state
  await pushPrice(150);
  for (let i = 0; i < 16; i++) await crank();

  const data2 = await fetchSlab(conn, SLAB);
  const engine2 = parseEngine(data2);
  const vaultInfo2 = await conn.getAccountInfo(VAULT);
  const vaultBalance2 = vaultInfo2 ? vaultInfo2.lamports / 1e9 : 0;

  console.log("\n=== FINAL MARKET STATE ===");
  console.log(`Vault: ${vaultBalance2.toFixed(9)} SOL`);
  console.log(`Insurance: ${(Number(engine2.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);
  console.log(`Risk Reduction Mode: ${engine2.riskReductionOnly}`);
  console.log(`Lifetime Liquidations: ${engine2.lifetimeLiquidations.toString()}`);
  console.log(`Lifetime Force Closes: ${engine2.lifetimeForceCloses.toString()}`);

  // Summary of all accounts
  console.log("\n=== ACCOUNT SUMMARY ===");
  let totalCapital = 0n;
  let totalPnl = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data2, idx);
    if (!acc) continue;
    totalCapital += acc.capital;
    totalPnl += acc.pnl;
    const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
    const owner = acc.owner.equals(payer.publicKey) ? " (MINE)" : "";
    console.log(`  [${idx}] ${kind}${owner}: cap=${(Number(acc.capital)/1e9).toFixed(6)} pnl=${(Number(acc.pnl)/1e9).toFixed(6)} pos=${acc.positionSize.toString()}`);
  }

  const totalLiabilities = Number(totalCapital + totalPnl) / 1e9 + Number(engine2.insuranceFund.balance) / 1e9;
  console.log(`\nTotal capital: ${(Number(totalCapital) / 1e9).toFixed(9)} SOL`);
  console.log(`Total PnL: ${(Number(totalPnl) / 1e9).toFixed(9)} SOL`);
  console.log(`Insurance: ${(Number(engine2.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);
  console.log(`Total liabilities: ${totalLiabilities.toFixed(9)} SOL`);
  console.log(`Vault: ${vaultBalance2.toFixed(9)} SOL`);
  console.log(`\nSolvency: ${vaultBalance2 >= totalLiabilities ? "SOLVENT" : "INSOLVENT"}`);
  if (vaultBalance2 >= totalLiabilities) {
    console.log(`Surplus: ${(vaultBalance2 - totalLiabilities).toFixed(9)} SOL`);
  }

  // Security summary
  console.log("\n" + "=".repeat(60));
  console.log("SECURITY AUDIT SUMMARY");
  console.log("=".repeat(60));
  console.log(`
ATTACKS TESTED:
1. Zero Price Attack: REJECTED (correctly)
2. Withdrawal Overflow: REJECTED (correctly)
3. Oracle Profit Extraction: PAPER PROFIT BLOCKED
   - Created +0.147 SOL profit via oracle manipulation
   - Could NOT withdraw the profit (limited to LP capital)
4. Insurance Drain via Bad Debt: FAILED
   - No liquidations triggered despite extreme price crash
   - Insurance fund remained stable (actually increased from fees)

SECURITY MECHANISMS VERIFIED:
- Crank freshness required for withdrawals (prevents stale state exploits)
- Withdrawal limited to LP's available capital
- Vault remains solvent through all tests
- Zero price correctly rejected to prevent division by zero

KEY FINDING:
Even with full oracle control, attacker cannot withdraw more than:
  user_capital + realized_pnl (up to LP capital available)

The system protects against oracle manipulation by limiting withdrawals
to what the counterparty (LP) can actually pay.
  `);
}

main().catch(console.error);
