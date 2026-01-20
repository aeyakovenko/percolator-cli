/**
 * Comprehensive Liquidation Test
 *
 * Now that LP has capital, test:
 * 1. Open a leveraged position
 * 2. Crash price to trigger liquidation
 * 3. Verify liquidation works correctly
 * 4. Try to exploit the mechanism
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseUsedIndices, parseAccount, parseParams, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeWithdrawCollateral, encodeLiquidateAtOracle } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_LIQUIDATE_AT_ORACLE } from "../src/abi/accounts.js";
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

function checkLiquidatable(acc: any, params: any, priceE6: bigint): { liquidatable: boolean; buffer: bigint; marginRatio: bigint } {
  const posAbs = acc.positionSize < 0n ? -acc.positionSize : acc.positionSize;
  const notional = posAbs * priceE6 / 1_000_000n;
  const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;

  // Handle pnl (might be negative stored as large positive)
  let pnl = acc.pnl;
  if (pnl > 9_000_000_000_000_000_000n) {
    pnl = pnl - 18446744073709551616n;
  }

  const effectiveCapital = acc.capital + pnl;
  const buffer = effectiveCapital - maintenanceReq;
  const marginRatio = notional > 0n ? (effectiveCapital * 10000n / notional) : 99999n;

  return {
    liquidatable: buffer < 0n,
    buffer,
    marginRatio,
  };
}

async function main() {
  log("=== COMPREHENSIVE LIQUIDATION TEST ===\n");

  // Initial state
  const { vaultBalance: v1, engine: e1, params, data: data1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;
  const liq1 = Number(e1.lifetimeLiquidations);

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Insurance: ${ins1.toFixed(6)} SOL`);
  log(`  Lifetime liquidations: ${liq1}`);
  log(`  Maintenance Margin: ${params.maintenanceMarginBps} bps (${Number(params.maintenanceMarginBps) / 100}%)`);
  log(`  Initial Margin: ${params.initialMarginBps} bps (${Number(params.initialMarginBps) / 100}%)`);

  // Find user account
  const indices = parseUsedIndices(data1);
  let userIdx = -1;
  let lpIdx = -1;

  log(`\nAccounts:`);
  for (const idx of indices) {
    const acc = parseAccount(data1, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
      if (acc.kind === AccountKind.LP && Number(acc.capital) > 0) {
        lpIdx = idx;
      }
      if (acc.kind === AccountKind.User && acc.owner.equals(payer.publicKey) && Number(acc.capital) > 0.1e9) {
        userIdx = idx;
      }
    }
  }

  if (userIdx < 0 || lpIdx < 0) {
    log("ERROR: Need both user and LP with capital");
    return;
  }

  log(`\nUsing userIdx=${userIdx}, lpIdx=${lpIdx}`);

  // ===== TEST 1: Open position and verify trade works =====
  log("\n=== TEST 1: Open Position ===");

  // Set price and crank
  await pushPrice(150);
  for (let i = 0; i < 5; i++) await crank();

  // Try to open a position
  log("Opening LONG position (1000000 units)...");
  const tradeResult = await trade(userIdx, lpIdx, 1000000n);
  log(`Trade result: ${tradeResult ? "SUCCESS" : "FAILED"}`);

  if (!tradeResult) {
    log("Cannot open position - test cannot continue");
    return;
  }

  await crank();

  // Check position
  const { data: data2 } = await getState();
  const userAcc2 = parseAccount(data2, userIdx);
  log(`Position opened: ${userAcc2.positionSize} units`);
  log(`User capital: ${Number(userAcc2.capital) / 1e9} SOL`);

  // Calculate notional at $150
  const notional150 = (userAcc2.positionSize < 0n ? -userAcc2.positionSize : userAcc2.positionSize) * 150_000_000n / 1_000_000n;
  log(`Position notional at $150: ${Number(notional150) / 1e9} SOL`);
  log(`Initial margin requirement (10%): ${Number(notional150 * params.initialMarginBps / 10_000n) / 1e9} SOL`);
  log(`Maintenance margin requirement (5%): ${Number(notional150 * params.maintenanceMarginBps / 10_000n) / 1e9} SOL`);

  // ===== TEST 2: Crash price to make position liquidatable =====
  log("\n=== TEST 2: Crash Price to Trigger Liquidation ===");

  // For a LONG position, we need price to DROP for liquidation
  // With 5% maintenance margin, we need effectiveCapital < notional * 0.05

  const crashPrices = [100, 50, 20, 10, 5, 2, 1];

  for (const crashPrice of crashPrices) {
    log(`\nCrashing price to $${crashPrice}...`);
    await pushPrice(crashPrice);

    // Crank multiple times to process
    for (let i = 0; i < 10; i++) {
      await crank();
    }

    const { engine, data, params: p } = await getState();
    const userAcc = parseAccount(data, userIdx);

    if (userAcc.positionSize === 0n) {
      log(`*** POSITION CLOSED (Liquidated or ADL?) ***`);
      log(`Lifetime liquidations: ${e1.lifetimeLiquidations} -> ${engine.lifetimeLiquidations}`);
      break;
    }

    const liqCheck = checkLiquidatable(userAcc, p, BigInt(crashPrice * 1_000_000));
    log(`  Position: ${userAcc.positionSize}`);
    log(`  Margin ratio: ${Number(liqCheck.marginRatio) / 100}%`);
    log(`  Buffer: ${Number(liqCheck.buffer) / 1e9} SOL`);
    log(`  Liquidatable: ${liqCheck.liquidatable}`);
    log(`  Lifetime liquidations: ${engine.lifetimeLiquidations}`);

    if (liqCheck.liquidatable) {
      log(`\n*** POSITION SHOULD BE LIQUIDATABLE ***`);
      log(`Running more cranks to trigger liquidation...`);
      for (let i = 0; i < 20; i++) {
        await crank();
      }

      const { engine: e2, data: d2 } = await getState();
      const userAcc3 = parseAccount(d2, userIdx);
      log(`After heavy cranking:`);
      log(`  Position: ${userAcc3.positionSize}`);
      log(`  Lifetime liquidations: ${e2.lifetimeLiquidations}`);

      if (Number(e2.lifetimeLiquidations) > liq1) {
        log(`*** LIQUIDATION TRIGGERED! ***`);
        break;
      }
    }

    // Try to exploit: withdraw while underwater
    log(`  Attempting withdrawal while underwater...`);
    const withdrawResult = await withdraw(userIdx, 100000000n);
    log(`  Withdrawal: ${withdrawResult ? "SUCCESS (VULNERABILITY?)" : "BLOCKED (correct)"}`);
  }

  // ===== TEST 3: Check final state =====
  log("\n=== FINAL STATE ===");

  await pushPrice(150);
  for (let i = 0; i < 10; i++) await crank();

  const { vaultBalance: v2, engine: e2, data: data3 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;
  const liq2 = Number(e2.lifetimeLiquidations);

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)} (Δ = ${(v2 - v1).toFixed(6)})`);
  log(`Insurance: ${ins1.toFixed(6)} -> ${ins2.toFixed(6)} (Δ = ${(ins2 - ins1).toFixed(6)})`);
  log(`Liquidations: ${liq1} -> ${liq2}`);

  log("\nFinal account states:");
  for (const idx of indices) {
    const acc = parseAccount(data3, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  // ===== SUMMARY =====
  log("\n=== SUMMARY ===");
  if (liq2 > liq1) {
    log(`LIQUIDATION TEST: ${liq2 - liq1} liquidation(s) triggered - POSITIVE PATH VERIFIED`);
  } else {
    log(`LIQUIDATION TEST: No liquidations triggered - INVESTIGATE!`);
  }

  if (Math.abs(v2 - v1) > 0.1) {
    log(`VAULT CHANGE: ${(v2 - v1).toFixed(6)} SOL - CHECK FOR EXPLOIT!`);
  } else {
    log(`VAULT: Protected (minimal change)`);
  }

  // Save results
  const results = {
    testTime: new Date().toISOString(),
    vaultBefore: v1,
    vaultAfter: v2,
    insuranceBefore: ins1,
    insuranceAfter: ins2,
    liquidationsBefore: liq1,
    liquidationsAfter: liq2,
    positionOpened: tradeResult,
  };
  fs.writeFileSync("audit-liquidation-test-results.json", JSON.stringify(results, null, 2));
  log("\nResults saved to audit-liquidation-test-results.json");
}

main().catch(console.error);
