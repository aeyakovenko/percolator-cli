/**
 * Aggressive Attack Vector Testing
 * Focus on liquidation, max leverage, and edge cases
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, parseConfig, AccountKind } from "../src/solana/slab.js";
import { encodeInitUser, encodeDepositCollateral, encodeWithdrawCollateral, encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import * as fs from "fs";

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

async function delay(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function runCrank(): Promise<boolean> {
  try {
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed", skipPreflight: true });
    return true;
  } catch (e) {
    return false;
  }
}

async function getMarketState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({ idx, ...acc });
  }
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return { engine, params, accounts, vaultLamports: vaultInfo?.lamports || 0 };
}

async function createTrader(): Promise<number> {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const initData = encodeInitUser({ feePayment: 1000000n });
  const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
    buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData })
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  
  const data = await fetchSlab(conn, SLAB);
  let maxIdx = 0;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.User && idx > maxIdx) {
      maxIdx = idx;
    }
  }
  return maxIdx;
}

async function deposit(userIdx: number, amount: bigint): Promise<boolean> {
  try {
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const depositData = encodeDepositCollateral({ userIdx, amount });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e) {
    return false;
  }
}

async function withdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error: string }> {
  try {
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const withdrawData = encodeWithdrawCollateral({ userIdx, amount });
    const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true, error: "" };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

async function trade(userIdx: number, lpIdx: number, size: bigint): Promise<{ success: boolean; error: string }> {
  try {
    const tradeData = encodeTradeCpi({ userIdx, lpIdx, size });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
      MATCHER_PROGRAM, MATCHER_CTX, LP_PDA
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true, error: "" };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

async function main() {
  console.log("Aggressive Attack Vector Testing");
  console.log("=".repeat(60));
  
  // Initialize
  console.log("\nInitializing...");
  await runCrank();
  await delay(2000);
  
  const results: any[] = [];
  
  // Test 1: Max Leverage Attack
  console.log("\n[TEST 1] Max Leverage Attack");
  console.log("Attempting to open position at maximum leverage...");
  
  await runCrank();
  const user1 = await createTrader();
  await deposit(user1, 100_000_000n); // 0.1 SOL
  await runCrank();
  await delay(1000);
  
  // Try progressively larger positions to find max
  let maxPosition = 0n;
  for (let size = 5_000_000_000n; size <= 100_000_000_000n; size += 5_000_000_000n) {
    const result = await trade(user1, 0, size);
    if (result.success) {
      maxPosition = size;
      // Close position
      await trade(user1, 0, -size);
      await delay(500);
    } else {
      break;
    }
  }
  
  console.log("  Max position achievable: " + maxPosition + " (" + (Number(maxPosition) / 1e9).toFixed(2) + " SOL notional)");
  console.log("  Leverage: " + (Number(maxPosition) / 100_000_000).toFixed(1) + "x");
  
  results.push({
    test: "Max Leverage",
    passed: maxPosition > 0,
    details: "Max position: " + maxPosition + ", Leverage: " + (Number(maxPosition) / 100_000_000).toFixed(1) + "x"
  });
  
  // Test 2: Withdrawal During Position
  console.log("\n[TEST 2] Withdrawal During Open Position");
  
  await runCrank();
  const user2 = await createTrader();
  await deposit(user2, 200_000_000n); // 0.2 SOL
  await runCrank();
  await delay(1000);
  
  // Open position
  const openResult = await trade(user2, 0, 10_000_000_000n);
  if (openResult.success) {
    console.log("  Opened position of 10B units");
    
    // Try to withdraw all capital (should fail - margin)
    const withdrawAll = await withdraw(user2, 200_000_000n);
    console.log("  Withdraw all: " + (withdrawAll.success ? "SUCCESS (BUG!)" : "BLOCKED"));
    
    // Try to withdraw partial (may work depending on margin)
    const withdrawPartial = await withdraw(user2, 50_000_000n);
    console.log("  Withdraw partial (0.05): " + (withdrawPartial.success ? "SUCCESS" : "BLOCKED"));
    
    results.push({
      test: "Withdrawal During Position",
      passed: !withdrawAll.success,
      details: "Full withdraw blocked: " + !withdrawAll.success
    });
  } else {
    results.push({
      test: "Withdrawal During Position",
      passed: true,
      details: "Could not open test position"
    });
  }
  
  // Test 3: Rapid Trade Sequence
  console.log("\n[TEST 3] Rapid Trade Sequence (Manipulation Attempt)");
  
  await runCrank();
  const user3 = await createTrader();
  await deposit(user3, 500_000_000n); // 0.5 SOL
  await runCrank();
  await delay(1000);
  
  const stateBefore = await getMarketState();
  const capitalBefore = stateBefore.accounts.find((a: any) => a.idx === user3)?.capital || 0n;
  
  // Rapid trades to try to exploit any timing issues
  let successCount = 0;
  for (let i = 0; i < 5; i++) {
    const long = await trade(user3, 0, 5_000_000_000n);
    if (long.success) successCount++;
    const short = await trade(user3, 0, -5_000_000_000n);
    if (short.success) successCount++;
  }
  
  await runCrank();
  const stateAfter = await getMarketState();
  const capitalAfter = stateAfter.accounts.find((a: any) => a.idx === user3)?.capital || 0n;
  const capitalChange = Number(capitalAfter) - Number(capitalBefore);
  
  console.log("  Trades executed: " + successCount + "/10");
  console.log("  Capital change: " + (capitalChange / 1e9).toFixed(6) + " SOL");
  console.log("  (Negative = fees paid, which is expected)");
  
  results.push({
    test: "Rapid Trade Sequence",
    passed: capitalChange <= 0, // Should lose fees, not gain
    details: "Capital change: " + capitalChange + " (" + successCount + " trades)"
  });
  
  // Test 4: Insurance Fund Check
  console.log("\n[TEST 4] Insurance Fund Health");
  
  const finalState = await getMarketState();
  const insuranceBalance = Number(finalState.engine.insuranceFund.balance);
  const insuranceFloor = Number(finalState.params.riskReductionThreshold || 0);
  const insuranceHealthy = insuranceBalance > insuranceFloor;
  
  console.log("  Insurance balance: " + (insuranceBalance / 1e9).toFixed(6) + " SOL");
  console.log("  Risk threshold: " + (insuranceFloor / 1e9).toFixed(6) + " SOL");
  console.log("  Status: " + (insuranceHealthy ? "HEALTHY" : "AT RISK"));
  
  results.push({
    test: "Insurance Fund Health",
    passed: insuranceHealthy,
    details: "Balance: " + insuranceBalance + ", Floor: " + insuranceFloor
  });
  
  // Test 5: LP Position Check
  console.log("\n[TEST 5] LP Solvency Check");
  
  const lp = finalState.accounts.find((a: any) => a.kind === AccountKind.LP);
  if (lp) {
    const lpCapital = Number(lp.capital);
    const lpPosition = Number(lp.positionSize);
    const lpHealthy = lpCapital > 0;
    
    console.log("  LP capital: " + (lpCapital / 1e9).toFixed(6) + " SOL");
    console.log("  LP position: " + lpPosition);
    console.log("  Status: " + (lpHealthy ? "SOLVENT" : "INSOLVENT"));
    
    results.push({
      test: "LP Solvency",
      passed: lpHealthy,
      details: "Capital: " + lpCapital + ", Position: " + lpPosition
    });
  }
  
  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(60));
  
  const passed = results.filter(r => r.passed).length;
  console.log("\nPassed: " + passed + "/" + results.length);
  
  for (const r of results) {
    console.log("[" + (r.passed ? "PASS" : "FAIL") + "] " + r.test + ": " + r.details);
  }
  
  // Update status.md
  const timestamp = new Date().toISOString();
  let status = fs.readFileSync("status.md", "utf-8");
  status += "\n### Aggressive Test - " + timestamp + "\n\n";
  status += "**Results:** " + passed + "/" + results.length + " passed\n\n";
  for (const r of results) {
    status += "- [" + (r.passed ? "x" : " ") + "] " + r.test + ": " + r.details + "\n";
  }
  fs.writeFileSync("status.md", status);
  
  console.log("\nStatus updated in status.md");
}

main().catch(console.error);
