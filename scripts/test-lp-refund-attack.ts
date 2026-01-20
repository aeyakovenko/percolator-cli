/**
 * LP Replenishment Attack
 *
 * Critical test: If LP is funded again, can User 2's paper profit be extracted?
 *
 * Current state:
 * - User 2 has 1M unit LONG at $10.05 entry
 * - Current price $150
 * - Expected profit is huge (unrealized)
 * - LP has 0 capital
 *
 * Attack:
 * 1. Fund LP with small amount
 * 2. Try to close User 2's position (realize profit)
 * 3. Attempt to withdraw realized profit
 * 4. Check if more was extracted than deposited
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, parseParams, AccountKind } from "../src/solana/slab.js";
import { encodeDepositCollateral, encodeKeeperCrank, encodePushOraclePrice, encodeWithdrawCollateral, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);
const LP_IDX = 0;

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const DELAY_MS = 2000;

async function delay(ms: number = DELAY_MS) {
  await new Promise(r => setTimeout(r, ms));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getState() {
  await delay(500);
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    engine: parseEngine(data),
    params: parseParams(data),
    data,
    vaultBalance: vaultInfo ? vaultInfo.lamports / 1e9 : 0,
  };
}

async function pushPrice(priceUsd: number): Promise<boolean> {
  await delay();
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
  } catch (e: any) {
    log(`PushPrice ${priceUsd} failed: ${e.message?.slice(0, 50)}`);
    return false;
  }
}

async function crank(): Promise<boolean> {
  await delay();
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

async function depositToLP(amountLamports: bigint): Promise<boolean> {
  await delay();
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const depositData = encodeDepositCollateral({ userIdx: LP_IDX, amount: amountLamports.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    log(`Deposit failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function trade(userIdx: number, lpIdx: number, size: bigint): Promise<boolean> {
  await delay();
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
    log(`Trade failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function withdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error?: string }> {
  await delay();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
  const vaultPda = new PublicKey(marketInfo.vaultPda);
  const withdrawData = encodeWithdrawCollateral({ idx: userIdx, amount });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message?.slice(0, 100) };
  }
}

async function main() {
  log("=== LP REPLENISHMENT ATTACK ===\n");

  // Initial state
  const { vaultBalance: v1, engine: e1, data: data1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Insurance: ${ins1.toFixed(9)} SOL`);

  const indices = parseUsedIndices(data1);
  log(`\nAccounts Before:`);
  for (const idx of indices) {
    const acc = parseAccount(data1, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pnl=${(Number(pnl) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  const user2Before = parseAccount(data1, 2);
  const lpBefore = parseAccount(data1, 0);
  log(`\nUser 2 has open LONG position: ${user2Before.positionSize} units at $${(Number(user2Before.entryPrice) / 1e6).toFixed(2)}`);

  // ===== ATTACK: Fund LP and Try to Extract User 2 Profit =====
  log("\n=== ATTACK PHASE ===");

  // Step 1: Fund LP with 0.5 SOL
  log("\nStep 1: Funding LP with 0.5 SOL...");
  const funded = await depositToLP(500_000_000n); // 0.5 SOL
  log(`  Deposit: ${funded ? "SUCCESS" : "FAILED"}`);

  if (!funded) {
    log("Cannot fund LP - test cannot continue");
    return;
  }

  await crank();
  await crank();

  const { data: data2 } = await getState();
  const lpAfterDeposit = parseAccount(data2, 0);
  log(`  LP capital after deposit: ${(Number(lpAfterDeposit.capital) / 1e9).toFixed(6)} SOL`);

  // Step 2: Set favorable price and try to close User 2's position
  log("\nStep 2: Setting price to $150 (User 2 should profit)...");
  await pushPrice(150);
  await crank();

  // Try to close User 2's position by trading in opposite direction
  // User 2 has LONG 1,000,000 - need SHORT to close
  log("\nStep 3: Attempting to close User 2's position (trade SHORT 1M)...");
  const closeResult = await trade(2, 0, -1_000_000n); // Negative = SHORT
  log(`  Close trade: ${closeResult ? "SUCCESS" : "FAILED"}`);

  await crank();
  await crank();

  const { data: data3 } = await getState();
  const user2AfterClose = parseAccount(data3, 2);
  let pnlAfterClose = user2AfterClose.pnl;
  if (Number(pnlAfterClose) > 9e18) pnlAfterClose = pnlAfterClose - 18446744073709551616n;
  log(`  User 2 after close:`);
  log(`    Position: ${user2AfterClose.positionSize}`);
  log(`    Capital: ${(Number(user2AfterClose.capital) / 1e9).toFixed(6)} SOL`);
  log(`    PnL: ${(Number(pnlAfterClose) / 1e9).toFixed(6)} SOL`);

  // Step 4: Try to withdraw profit
  log("\nStep 4: Attempting to withdraw any profit...");
  const capitalPlusPnl = Number(user2AfterClose.capital) + Number(pnlAfterClose);
  const withdrawAmount = BigInt(Math.max(0, Math.floor(capitalPlusPnl * 0.9))); // Try to withdraw 90%
  log(`  Attempting to withdraw ${Number(withdrawAmount) / 1e9} SOL...`);

  const wResult = await withdraw(2, withdrawAmount);
  log(`  Withdrawal: ${wResult.success ? "SUCCESS" : "BLOCKED"}`);
  if (!wResult.success) log(`  Error: ${wResult.error?.slice(0, 60)}`);

  // Try smaller withdrawals
  log("\nTrying smaller withdrawals:");
  for (const amt of [100_000_000n, 50_000_000n, 10_000_000n]) {
    const r = await withdraw(2, amt);
    log(`  ${Number(amt) / 1e9} SOL: ${r.success ? "SUCCESS (!)" : "blocked"}`);
    if (r.success) break;
  }

  // ===== FINAL STATE =====
  log("\n=== FINAL STATE ===");

  const { vaultBalance: v2, engine: e2, data: data4 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)} (Δ = ${(v2 - v1).toFixed(6)})`);
  log(`Insurance: ${ins1.toFixed(9)} -> ${ins2.toFixed(9)}`);

  log("\nFinal account states:");
  for (const idx of indices) {
    const acc = parseAccount(data4, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pnl=${(Number(pnl) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  // Calculate net extraction
  log("\n=== EXTRACTION ANALYSIS ===");
  const deposited = 0.5; // SOL deposited to LP
  const vaultChange = v2 - v1;
  const netExtraction = -(vaultChange - deposited); // Negative vault change minus deposit = extraction

  log(`Deposited to LP: ${deposited} SOL`);
  log(`Vault change: ${vaultChange.toFixed(6)} SOL`);
  log(`Net extraction: ${netExtraction.toFixed(6)} SOL`);

  if (netExtraction > 0.01) {
    log(`\n*** WARNING: ${netExtraction.toFixed(6)} SOL extracted beyond deposit! ***`);
    log(`This could indicate a vulnerability!`);
  } else if (vaultChange < deposited - 0.01) {
    log(`\n*** ATTACKER LOST ${(deposited - vaultChange).toFixed(6)} SOL ***`);
    log(`Security mechanism is working - cannot profit from LP refunding`);
  } else {
    log(`\nVault change matches deposit - no unexpected extraction`);
  }

  // Solvency check
  log("\n=== SOLVENCY CHECK ===");
  let totalLiabilities = e2.insuranceFund.balance;
  for (const idx of indices) {
    const acc = parseAccount(data4, idx);
    if (acc) {
      totalLiabilities += acc.capital;
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      totalLiabilities += pnl;
    }
  }
  const liabilitiesNum = Number(totalLiabilities) / 1e9;
  log(`Total Liabilities: ${liabilitiesNum.toFixed(6)} SOL`);
  log(`Vault Balance: ${v2.toFixed(6)} SOL`);
  log(`Status: ${v2 >= liabilitiesNum ? "SOLVENT" : "*** INSOLVENT ***"}`);
}

main().catch(console.error);
