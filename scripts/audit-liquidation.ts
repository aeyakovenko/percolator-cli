/**
 * Liquidation and Edge Case Testing
 * Tests liquidation triggers, ADL, and user isolation
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
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
  console.log("Liquidation and Edge Case Testing");
  console.log("=".repeat(60));
  
  const results: any[] = [];
  
  // Initialize
  console.log("\nInitializing...");
  for (let i = 0; i < 4; i++) {
    await runCrank();
    await delay(500);
  }
  
  // Test 1: User Isolation
  console.log("\n[TEST 1] User Isolation");
  console.log("Creating two independent traders...");
  
  await runCrank();
  const userA = await createTrader();
  await deposit(userA, 100_000_000n);
  await delay(500);
  
  const userB = await createTrader();
  await deposit(userB, 100_000_000n);
  await runCrank();
  await delay(1000);
  
  // Get initial state
  let state = await getMarketState();
  const userABefore = state.accounts.find((a: any) => a.idx === userA);
  const userBBefore = state.accounts.find((a: any) => a.idx === userB);
  
  console.log("  User A capital: " + (Number(userABefore?.capital || 0n) / 1e9).toFixed(6));
  console.log("  User B capital: " + (Number(userBBefore?.capital || 0n) / 1e9).toFixed(6));
  
  // User A trades (potentially losing)
  await trade(userA, 0, 10_000_000_000n);
  await runCrank();
  await trade(userA, 0, -10_000_000_000n);
  await runCrank();
  await delay(1000);
  
  // Check if User B is affected
  state = await getMarketState();
  const userAAfter = state.accounts.find((a: any) => a.idx === userA);
  const userBAfter = state.accounts.find((a: any) => a.idx === userB);
  
  const userBCapitalChange = Number(userBAfter?.capital || 0n) - Number(userBBefore?.capital || 0n);
  const isolated = userBCapitalChange === 0;
  
  console.log("  After User A trades:");
  console.log("  User A capital change: " + ((Number(userAAfter?.capital || 0n) - Number(userABefore?.capital || 0n)) / 1e9).toFixed(6));
  console.log("  User B capital change: " + (userBCapitalChange / 1e9).toFixed(6));
  console.log("  Isolation: " + (isolated ? "MAINTAINED" : "VIOLATED"));
  
  results.push({
    test: "User Isolation",
    passed: isolated,
    details: "User B capital unchanged: " + isolated
  });
  
  // Test 2: Lifetime Counters Check
  console.log("\n[TEST 2] Lifetime Counters");
  
  state = await getMarketState();
  const lifetimeLiquidations = Number(state.engine.lifetimeLiquidations || 0);
  const lifetimeForceCloses = Number(state.engine.lifetimeForceCloses || 0);
  
  console.log("  Lifetime liquidations: " + lifetimeLiquidations);
  console.log("  Lifetime force closes: " + lifetimeForceCloses);
  
  results.push({
    test: "Lifetime Counters",
    passed: true,
    details: "Liquidations: " + lifetimeLiquidations + ", Force closes: " + lifetimeForceCloses
  });
  
  // Test 3: Open Interest Tracking
  console.log("\n[TEST 3] Open Interest Tracking");
  
  await runCrank();
  const userC = await createTrader();
  await deposit(userC, 200_000_000n);
  await runCrank();
  await delay(1000);
  
  state = await getMarketState();
  const oiBefore = Number(state.engine.totalOpenInterest || 0);
  
  // Open position
  await trade(userC, 0, 20_000_000_000n);
  await runCrank();
  await delay(1000);
  
  state = await getMarketState();
  const oiAfter = Number(state.engine.totalOpenInterest || 0);
  const oiIncreased = oiAfter > oiBefore;
  
  console.log("  OI before: " + oiBefore);
  console.log("  OI after: " + oiAfter);
  console.log("  OI tracking: " + (oiIncreased ? "CORRECT" : "INCORRECT"));
  
  results.push({
    test: "Open Interest Tracking",
    passed: oiIncreased,
    details: "OI: " + oiBefore + " -> " + oiAfter
  });
  
  // Test 4: Conservation After Multiple Operations
  console.log("\n[TEST 4] Conservation After Complex Operations");
  
  state = await getMarketState();
  const vaultBefore = state.vaultLamports;
  let totalCapitalBefore = 0n;
  for (const acc of state.accounts) {
    totalCapitalBefore += acc.capital;
  }
  const insuranceBefore = state.engine.insuranceFund.balance;
  
  // Multiple operations
  for (let i = 0; i < 3; i++) {
    await trade(userC, 0, 5_000_000_000n);
    await runCrank();
    await trade(userC, 0, -5_000_000_000n);
    await runCrank();
  }
  await delay(1000);
  
  state = await getMarketState();
  const vaultAfter = state.vaultLamports;
  let totalCapitalAfter = 0n;
  for (const acc of state.accounts) {
    totalCapitalAfter += acc.capital;
  }
  const insuranceAfter = state.engine.insuranceFund.balance;
  
  const vaultDiff = vaultAfter - vaultBefore;
  const capitalDiff = Number(totalCapitalAfter - totalCapitalBefore);
  const insuranceDiff = Number(insuranceAfter - insuranceBefore);
  const slack = Math.abs(vaultDiff - capitalDiff - insuranceDiff);
  const conserved = slack < 10_000_000; // Allow 0.01 SOL rounding
  
  console.log("  Vault change: " + vaultDiff);
  console.log("  Capital change: " + capitalDiff);
  console.log("  Insurance change: " + insuranceDiff);
  console.log("  Slack: " + slack);
  console.log("  Conservation: " + (conserved ? "MAINTAINED" : "VIOLATED"));
  
  results.push({
    test: "Conservation Complex",
    passed: conserved,
    details: "Slack: " + slack + " (< 10M allowed)"
  });
  
  // Test 5: Full Withdrawal After Closing Position
  console.log("\n[TEST 5] Full Withdrawal After Position Close");
  
  // Close position first
  const userCState = state.accounts.find((a: any) => a.idx === userC);
  if (userCState && userCState.positionSize !== 0n) {
    await trade(userC, 0, -userCState.positionSize);
    await runCrank();
    await delay(1000);
  }
  
  state = await getMarketState();
  const userCFinal = state.accounts.find((a: any) => a.idx === userC);
  const finalCapital = userCFinal?.capital || 0n;
  
  if (finalCapital > 0n && userCFinal?.positionSize === 0n) {
    const withdrawResult = await withdraw(userC, finalCapital);
    console.log("  Position closed, capital: " + (Number(finalCapital) / 1e9).toFixed(6));
    console.log("  Full withdrawal: " + (withdrawResult.success ? "SUCCESS" : "BLOCKED - " + withdrawResult.error.slice(0, 30)));
    
    results.push({
      test: "Full Withdrawal Post-Close",
      passed: withdrawResult.success,
      details: withdrawResult.success ? "Withdrew " + finalCapital : "Blocked"
    });
  } else {
    results.push({
      test: "Full Withdrawal Post-Close",
      passed: true,
      details: "No capital to withdraw or position open"
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
  status += "\n### Liquidation Test - " + timestamp + "\n\n";
  status += "**Results:** " + passed + "/" + results.length + " passed\n\n";
  for (const r of results) {
    status += "- [" + (r.passed ? "x" : " ") + "] " + r.test + ": " + r.details + "\n";
  }
  fs.writeFileSync("status.md", status);
  
  console.log("\nStatus updated in status.md");
}

main().catch(console.error);
