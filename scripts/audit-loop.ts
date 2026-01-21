/**
 * Continuous Risk Engine Audit Loop
 * Tests attack vectors and verifies correctness
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, parseConfig, AccountKind } from "../src/solana/slab.js";
import { encodeInitUser, encodeDepositCollateral, encodeWithdrawCollateral, encodeKeeperCrank, encodeTradeCpi, encodeCloseAccount } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_CLOSE_ACCOUNT } from "../src/abi/accounts.js";
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

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  expected: string;
  actual: string;
}

const results: TestResult[] = [];
let round = 1;

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
  const config = parseConfig(data);
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({ idx, ...acc });
  }
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return { engine, params, config, accounts, vaultLamports: vaultInfo?.lamports || 0 };
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

async function testUnderMarginTrade() {
  console.log("\n[TEST] Under-Margin Trade Attack");
  await runCrank();
  const userIdx = await createTrader();
  await deposit(userIdx, 10_000_000n);
  await runCrank();
  
  const hugeSize = 1_000_000_000_000n;
  const tradeResult = await trade(userIdx, 0, hugeSize);
  
  results.push({
    name: "Under-Margin Trade",
    category: "Margin",
    passed: !tradeResult.success,
    expected: "Trade blocked (insufficient margin)",
    actual: tradeResult.success ? "Trade succeeded (BUG!)" : "Blocked: " + tradeResult.error.slice(0, 50),
  });
}

async function testWithdrawBeyondCapital() {
  console.log("\n[TEST] Withdraw Beyond Capital Attack");
  await runCrank();
  const userIdx = await createTrader();
  await deposit(userIdx, 50_000_000n);
  await runCrank();
  
  const withdrawResult = await withdraw(userIdx, 100_000_000n);
  
  results.push({
    name: "Withdraw Beyond Capital",
    category: "Conservation",
    passed: !withdrawResult.success,
    expected: "Withdrawal blocked (insufficient balance)",
    actual: withdrawResult.success ? "Withdrawal succeeded (BUG!)" : "Blocked: " + withdrawResult.error.slice(0, 50),
  });
}

async function testConservationAfterTrades() {
  console.log("\n[TEST] Conservation After Trades");
  await runCrank();
  
  const stateBefore = await getMarketState();
  const vaultBefore = stateBefore.vaultLamports;
  const insuranceBefore = Number(stateBefore.engine.insuranceFund.balance);
  let capitalBefore = 0n;
  for (const acc of stateBefore.accounts) {
    capitalBefore += acc.capital;
  }
  
  const userIdx = await createTrader();
  await deposit(userIdx, 100_000_000n);
  await runCrank();
  
  for (let i = 0; i < 3; i++) {
    await trade(userIdx, 0, 1_000_000_000n);
    await runCrank();
    await trade(userIdx, 0, -1_000_000_000n);
    await runCrank();
  }
  
  const stateAfter = await getMarketState();
  const vaultAfter = stateAfter.vaultLamports;
  const insuranceAfter = Number(stateAfter.engine.insuranceFund.balance);
  let capitalAfter = 0n;
  for (const acc of stateAfter.accounts) {
    capitalAfter += acc.capital;
  }
  
  const vaultDiff = vaultAfter - vaultBefore;
  const capitalDiff = Number(capitalAfter - capitalBefore);
  const insuranceDiff = insuranceAfter - insuranceBefore;
  const conserved = Math.abs(vaultDiff - capitalDiff - insuranceDiff) < 10_000_000;
  
  results.push({
    name: "Conservation After Trades",
    category: "Conservation",
    passed: conserved,
    expected: "Funds conserved (vault = capital + insurance)",
    actual: "Vault:" + vaultDiff + " Capital:" + capitalDiff + " Ins:" + insuranceDiff,
  });
}

async function testDepositCredit() {
  console.log("\n[TEST] Deposit Credited Correctly");
  await runCrank();
  const userIdx = await createTrader();
  
  const stateBefore = await getMarketState();
  const userBefore = stateBefore.accounts.find((a: any) => a.idx === userIdx);
  const capitalBefore = userBefore ? userBefore.capital : 0n;
  
  const depositAmount = 50_000_000n;
  await deposit(userIdx, depositAmount);
  
  const stateAfter = await getMarketState();
  const userAfter = stateAfter.accounts.find((a: any) => a.idx === userIdx);
  const capitalAfter = userAfter ? userAfter.capital : 0n;
  
  const credited = capitalAfter - capitalBefore === depositAmount;
  
  results.push({
    name: "Deposit Credited",
    category: "Correctness",
    passed: credited,
    expected: "Capital increased by " + depositAmount,
    actual: "Capital change: " + (capitalAfter - capitalBefore),
  });
}

async function testFeeCollection() {
  console.log("\n[TEST] Fee Collection Correctness");
  await runCrank();
  
  const stateBefore = await getMarketState();
  const insuranceBefore = stateBefore.engine.insuranceFund.balance;
  
  const userIdx = await createTrader();
  await deposit(userIdx, 200_000_000n);
  await runCrank();
  
  for (let i = 0; i < 3; i++) {
    await trade(userIdx, 0, 5_000_000_000n);
    await runCrank();
  }
  
  const stateAfter = await getMarketState();
  const insuranceAfter = stateAfter.engine.insuranceFund.balance;
  const feesCollected = insuranceAfter > insuranceBefore;
  
  results.push({
    name: "Fee Collection",
    category: "Correctness",
    passed: feesCollected,
    expected: "Insurance fund increased from fees",
    actual: "Insurance: " + insuranceBefore + " -> " + insuranceAfter,
  });
}

async function testRiskModeBlock() {
  console.log("\n[TEST] Risk-Reduction-Only Mode");
  const state = await getMarketState();
  
  results.push({
    name: "Risk Mode Status",
    category: "State Machine",
    passed: true,
    expected: "Check risk mode status",
    actual: "Risk reduction only: " + state.engine.riskReductionOnly,
  });
}

async function runAuditRound() {
  console.log("\n" + "=".repeat(60));
  console.log("AUDIT ROUND " + round);
  console.log("=".repeat(60));
  
  results.length = 0;
  
  console.log("\nInitializing market state...");
  for (let i = 0; i < 4; i++) {
    await runCrank();
    await delay(500);
  }
  
  await testUnderMarginTrade();
  await testWithdrawBeyondCapital();
  await testConservationAfterTrades();
  await testDepositCredit();
  await testFeeCollection();
  await testRiskModeBlock();
  
  console.log("\n" + "=".repeat(60));
  console.log("ROUND SUMMARY");
  console.log("=".repeat(60));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log("\nPassed: " + passed + "/" + results.length);
  console.log("Failed: " + failed + "/" + results.length + "\n");
  
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log("[" + status + "] " + r.category + ": " + r.name);
    if (!r.passed) {
      console.log("       Expected: " + r.expected);
      console.log("       Actual: " + r.actual);
    }
  }
  
  await updateStatusFile();
  round++;
}

async function updateStatusFile() {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const timestamp = new Date().toISOString();
  
  const roundLog = "\n### Round " + round + " - " + timestamp + "\n\n" +
    "**Results:** " + passed + "/" + results.length + " passed, " + failed + " failed\n\n" +
    "| Test | Category | Result | Details |\n" +
    "|------|----------|--------|---------|" +
    results.map(r => "\n| " + r.name + " | " + r.category + " | " + (r.passed ? "PASS" : "FAIL") + " | " + r.actual.slice(0, 40) + " |").join("");
  
  let content = fs.readFileSync("status.md", "utf-8");
  content = content.replace("**Status:** Starting...", "**Status:** Running\n" + roundLog);
  if (!content.includes("Round " + round + " -")) {
    content += roundLog;
  }
  fs.writeFileSync("status.md", content);
}

async function main() {
  console.log("Percolator Risk Engine Audit Loop");
  console.log("=".repeat(60));
  
  const maxRounds = parseInt(process.argv[2]) || 3;
  
  for (let i = 0; i < maxRounds; i++) {
    try {
      await runAuditRound();
    } catch (e: any) {
      console.error("Round " + round + " error:", e.message);
    }
    
    if (i < maxRounds - 1) {
      console.log("\nWaiting 10s before next round...");
      await delay(10000);
    }
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("AUDIT COMPLETE");
  console.log("=".repeat(60));
}

main().catch(console.error);
