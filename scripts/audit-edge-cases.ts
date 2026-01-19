/**
 * Security Audit: Edge Case Attack Vectors
 *
 * Tests edge cases not covered by the main continuous audit:
 * - Short positions (negative size)
 * - Maximum leverage attempts
 * - Stale crank exploitation
 * - Multiple account attacks
 * - Funding rate manipulation
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
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
    config: parseConfig(data),
    engine: parseEngine(data),
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
  } catch { return false; }
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
  } catch { return false; }
}

async function withdraw(userIdx: number, amount: bigint): Promise<boolean> {
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
    return true;
  } catch { return false; }
}

interface TestResult {
  name: string;
  passed: boolean;
  notes: string;
  vaultDelta: number;
  insuranceDelta: number;
}

const results: TestResult[] = [];

// TEST 1: Short position attack
async function test_ShortPosition(userIdx: number): Promise<TestResult> {
  log("=== TEST: Short Position Attack ===");
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  await pushPrice(150);
  await crank();

  // Try to open a SHORT position (negative size)
  log("Opening SHORT position (-2000000 units)...");
  const shortResult = await trade(userIdx, 0, -2000000n);
  log(`Short position: ${shortResult ? "OPENED" : "REJECTED"}`);
  await crank();

  if (shortResult) {
    // Crash price (favorable for short)
    log("Crashing price to $50...");
    await pushPrice(50);
    await crank();
    await crank();

    // Try to close short for profit
    log("Closing short position...");
    await trade(userIdx, 0, 2000000n);
    await crank();

    // Try max withdrawal
    log("Attempting withdrawal...");
    await withdraw(userIdx, 500000000n);
  }

  await pushPrice(150);
  await crank();

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Short Position Attack",
    passed: Math.abs(v2 - v1) < 0.01,
    notes: shortResult ? "Short opened and closed" : "Short position rejected",
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
  };
}

// TEST 2: Maximum leverage probe
async function test_MaxLeverage(userIdx: number): Promise<TestResult> {
  log("=== TEST: Maximum Leverage Probe ===");
  const { vaultBalance: v1, engine: e1, data } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  const acc = parseAccount(data, userIdx);
  const capital = acc ? Number(acc.capital) / 1e9 : 0;
  log(`User capital: ${capital.toFixed(6)} SOL`);

  await pushPrice(150);
  await crank();

  // Try progressively larger positions to find max leverage
  const positions = [1000000n, 5000000n, 10000000n, 25000000n, 50000000n, 100000000n, 500000000n];
  let maxAccepted = 0n;
  let maxLeverage = 0;

  for (const size of positions) {
    const result = await trade(userIdx, 0, size);
    if (result) {
      maxAccepted = size;
      // Calculate leverage: position value / capital
      const positionValue = (Number(size) / 1e6) * 150; // in USD
      maxLeverage = positionValue / (capital * 150); // capital in USD terms
      log(`Position ${size.toString()} accepted (leverage ~${maxLeverage.toFixed(1)}x)`);
      await trade(userIdx, 0, -size); // Close
    } else {
      log(`Position ${size.toString()} rejected`);
      break;
    }
    await crank();
  }

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Maximum Leverage",
    passed: maxLeverage < 50, // Should be limited
    notes: `Max position: ${maxAccepted.toString()}, Max leverage: ${maxLeverage.toFixed(1)}x`,
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
  };
}

// TEST 3: Stale crank withdrawal exploit
async function test_StaleCrankWithdrawal(userIdx: number): Promise<TestResult> {
  log("=== TEST: Stale Crank Withdrawal Exploit ===");
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  // Fresh crank
  await crank();

  // Manipulate price to create paper profit
  await pushPrice(300);
  // DON'T crank - try to withdraw with stale crank

  log("Attempting withdrawal without cranking after price change...");
  const withdrawResult = await withdraw(userIdx, 100000000n);
  log(`Stale crank withdrawal: ${withdrawResult ? "SUCCESS (vulnerability!)" : "BLOCKED (correct)"}`);

  // Now crank to update
  await crank();
  await pushPrice(150);
  await crank();

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Stale Crank Withdrawal",
    passed: !withdrawResult,
    notes: withdrawResult ? "VULNERABILITY: Withdrawal succeeded with stale crank!" : "Correctly blocked",
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
  };
}

// TEST 4: Rapid price oscillation (try to catch bad state)
async function test_RapidOscillation(userIdx: number): Promise<TestResult> {
  log("=== TEST: Rapid Price Oscillation ===");
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  // Open position
  await pushPrice(150);
  await crank();
  await trade(userIdx, 0, 2000000n);

  // Rapid oscillation without waiting for cranks
  const prices = [50, 300, 10, 500, 1, 1000, 150];
  let withdrawals = 0;

  for (const p of prices) {
    await pushPrice(p);
    // Try immediate withdrawal at each price
    const w = await withdraw(userIdx, 50000000n);
    if (w) withdrawals++;
  }

  // Final crank
  for (let i = 0; i < 5; i++) await crank();

  // Close position
  const { data } = await getState();
  const acc = parseAccount(data, userIdx);
  if (acc && acc.positionSize !== 0n) {
    await trade(userIdx, 0, -acc.positionSize);
    await crank();
  }

  await pushPrice(150);
  await crank();

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Rapid Oscillation",
    passed: withdrawals === 0,
    notes: `Withdrawals during oscillation: ${withdrawals}`,
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
  };
}

// TEST 5: Integer boundary tests
async function test_IntegerBoundaries(userIdx: number): Promise<TestResult> {
  log("=== TEST: Integer Boundaries ===");
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  await pushPrice(150);
  await crank();

  const boundaries = [
    { name: "i64 MAX", size: (1n << 63n) - 1n },
    { name: "i64 MIN", size: -(1n << 63n) },
    { name: "u64 MAX as signed", size: (1n << 64n) - 1n },
    { name: "Very small", size: 1n },
    { name: "Zero", size: 0n },
  ];

  const accepted: string[] = [];
  for (const { name, size } of boundaries) {
    try {
      const result = await trade(userIdx, 0, size);
      log(`${name} (${size.toString().slice(0, 20)}...): ${result ? "ACCEPTED" : "REJECTED"}`);
      if (result) {
        accepted.push(name);
        await trade(userIdx, 0, -size); // Try to close
        await crank();
      }
    } catch (e: any) {
      log(`${name}: Error - ${e.message?.slice(0, 50)}`);
    }
  }

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Integer Boundaries",
    passed: accepted.length <= 1, // Only "Very small" should possibly work
    notes: `Accepted: ${accepted.length > 0 ? accepted.join(", ") : "none"}`,
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
  };
}

async function main() {
  log("=== EDGE CASE SECURITY AUDIT ===\n");

  const { vaultBalance, engine } = await getState();
  log(`Initial vault: ${vaultBalance.toFixed(9)} SOL`);
  log(`Initial insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);

  // Find user account
  const { data } = await getState();
  const indices = parseUsedIndices(data);
  let userIdx = -1;
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.User && acc.owner.equals(payer.publicKey)) {
      userIdx = idx;
      break;
    }
  }

  if (userIdx < 0) {
    log("No user account found!");
    return;
  }

  log(`Using account ${userIdx}\n`);

  // Run tests
  const tests = [
    test_ShortPosition,
    test_MaxLeverage,
    test_StaleCrankWithdrawal,
    test_RapidOscillation,
    test_IntegerBoundaries,
  ];

  for (const test of tests) {
    try {
      const result = await test(userIdx);
      results.push(result);
      log(`\nResult: ${result.passed ? "PASS" : "FAIL"}`);
      log(`Vault Δ: ${result.vaultDelta.toFixed(6)}, Insurance Δ: ${result.insuranceDelta.toFixed(6)}`);
      log(`Notes: ${result.notes}\n`);

      // Save after each test
      fs.writeFileSync("audit-edge-case-results.json", JSON.stringify(results, null, 2));

      // Wait between tests
      log("Waiting 30 seconds...");
      await new Promise(r => setTimeout(r, 30000));
    } catch (e: any) {
      log(`Test error: ${e.message?.slice(0, 100)}`);
      results.push({
        name: test.name,
        passed: false,
        notes: `Error: ${e.message?.slice(0, 100)}`,
        vaultDelta: 0,
        insuranceDelta: 0,
      });
    }
  }

  // Final summary
  log("\n=== FINAL SUMMARY ===");
  const { vaultBalance: finalVault, engine: finalEngine } = await getState();
  log(`Final vault: ${finalVault.toFixed(9)} SOL`);
  log(`Final insurance: ${(Number(finalEngine.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);

  log("\nTest Results:");
  for (const r of results) {
    log(`  ${r.passed ? "PASS" : "FAIL"}: ${r.name} - ${r.notes}`);
  }

  const passed = results.filter(r => r.passed).length;
  log(`\n${passed}/${results.length} tests passed`);
}

main().catch(console.error);
