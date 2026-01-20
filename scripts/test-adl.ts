/**
 * Test ADL (Auto-Deleveraging) Mechanism
 *
 * ADL should trigger when:
 * 1. A position has bad debt (losses > capital)
 * 2. Insurance fund can't cover the bad debt
 * 3. LP capital can't cover the bad debt
 * 4. System force-closes profitable positions to balance
 *
 * Current state:
 * - User 2 has LONG 1M units at $10.05 entry
 * - Insurance: ~0.0003 SOL (nearly empty)
 * - LP: ~0 SOL
 *
 * Test:
 * 1. Crash price to create massive losses for User 2
 * 2. Verify ADL/force close is triggered
 * 3. Check position closure and system balance
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, parseParams, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeLiquidateAtOracle } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_LIQUIDATE_AT_ORACLE } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);

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

async function liquidate(userIdx: number, lpIdx: number): Promise<boolean> {
  await delay();
  const liqData = encodeLiquidateAtOracle({ userIdx, lpIdx });
  const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    buildIx({ programId: PROGRAM_ID, keys: liqKeys, data: liqData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

function calculatePnL(acc: any, currentPriceE6: bigint, isInverted: boolean): bigint {
  if (acc.positionSize === 0n) return 0n;

  const posSize = acc.positionSize;
  const entryPrice = acc.entryPrice;

  // For inverted perpetual (SOL collateral):
  // LONG profits when price goes UP
  // PnL = position_size * (current_price - entry_price) / scale
  // But in inverted markets the calculation is different

  if (isInverted) {
    // For inverted: PnL = position * (1/entry - 1/current) * scale
    // This is in the collateral currency (SOL)
    if (Number(currentPriceE6) > 0 && Number(entryPrice) > 0) {
      const invEntry = 1e12 / Number(entryPrice); // 1/entry scaled by 1e6
      const invCurrent = 1e12 / Number(currentPriceE6); // 1/current scaled by 1e6
      const pnl = Number(posSize) * (invEntry - invCurrent) / 1e6;
      return BigInt(Math.round(pnl));
    }
  } else {
    // Standard: PnL = position * (current - entry) / scale
    const priceDiff = Number(currentPriceE6) - Number(entryPrice);
    const pnl = Number(posSize) * priceDiff / 1e6;
    return BigInt(Math.round(pnl));
  }

  return 0n;
}

async function main() {
  log("=== ADL (AUTO-DELEVERAGING) TEST ===\n");

  // Initial state
  const { vaultBalance: v1, engine: e1, params, data: data1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;
  const fc1 = Number(e1.lifetimeForceCloses);
  const liq1 = Number(e1.lifetimeLiquidations);

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Insurance: ${ins1.toFixed(9)} SOL`);
  log(`  Lifetime Liquidations: ${liq1}`);
  log(`  Lifetime Force Closes (ADL): ${fc1}`);
  log(`  Maintenance Margin: ${params.maintenanceMarginBps} bps (${Number(params.maintenanceMarginBps) / 100}%)`);

  // Check accounts
  const indices = parseUsedIndices(data1);
  log(`\nAccounts Before:`);
  for (const idx of indices) {
    const acc = parseAccount(data1, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize} entry=$${(Number(acc.entryPrice) / 1e6).toFixed(2)}`);
    }
  }

  // Find user with position
  let userWithPosition = -1;
  for (const idx of indices) {
    const acc = parseAccount(data1, idx);
    if (acc && acc.kind === AccountKind.User && acc.positionSize !== 0n) {
      userWithPosition = idx;
      log(`\nUser ${idx} has position: ${acc.positionSize} units at $${(Number(acc.entryPrice) / 1e6).toFixed(2)}`);
      log(`  Capital: ${(Number(acc.capital) / 1e9).toFixed(6)} SOL`);

      // Calculate when they become liquidatable
      const capital = Number(acc.capital);
      const posAbs = Math.abs(Number(acc.positionSize));
      const maintenanceMarginBps = Number(params.maintenanceMarginBps);

      // For LONG at $10.05 entry, they become liquidatable when:
      // effective_capital < notional * maintenance_margin
      // capital + pnl < (posAbs * price / 1e6) * maintenance_margin / 10000

      // At what price does pnl make them liquidatable?
      // For LONG with inverted market: as price DROPS, they LOSE
      log(`  They should become liquidatable if price drops significantly`);
    }
  }

  if (userWithPosition < 0) {
    log("\nNo user with position found - cannot test ADL");
    return;
  }

  // ===== ADL TEST: Crash price to create bad debt =====
  log("\n=== ADL TEST: Crash Price to Create Bad Debt ===");

  // User 2 has LONG at $10.05 with 0.5 SOL capital
  // If price crashes to near $0, their losses will exceed capital
  // With empty insurance and no LP capital, ADL should trigger

  const crashPrices = [5, 2, 1, 0.5, 0.1, 0.01];

  for (const crashPrice of crashPrices) {
    log(`\n--- Testing at $${crashPrice} ---`);

    await pushPrice(crashPrice);

    // Heavy cranking to trigger any ADL
    for (let i = 0; i < 10; i++) {
      await crank();
    }

    // Also try explicit liquidation
    await liquidate(userWithPosition, 0);

    // More cranking
    for (let i = 0; i < 5; i++) {
      await crank();
    }

    const { engine, data } = await getState();
    const userAcc = parseAccount(data, userWithPosition);

    log(`  Position: ${userAcc.positionSize}`);
    log(`  Capital: ${(Number(userAcc.capital) / 1e9).toFixed(6)} SOL`);
    log(`  Liquidations: ${liq1} -> ${engine.lifetimeLiquidations}`);
    log(`  Force Closes (ADL): ${fc1} -> ${engine.lifetimeForceCloses}`);

    if (userAcc.positionSize === 0n) {
      log(`  *** POSITION CLOSED! ***`);
      if (Number(engine.lifetimeForceCloses) > fc1) {
        log(`  *** ADL TRIGGERED (force close count increased) ***`);
      } else if (Number(engine.lifetimeLiquidations) > liq1) {
        log(`  *** LIQUIDATION TRIGGERED ***`);
      }
      break;
    }

    // Check if position should be liquidatable
    const posAbs = userAcc.positionSize < 0n ? -userAcc.positionSize : userAcc.positionSize;
    const notional = posAbs * BigInt(Math.round(crashPrice * 1e6)) / 1_000_000n;
    const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;

    // For inverted LONG: as price drops, PnL should be negative
    // PnL ≈ position * (1/entry - 1/current)
    // At $10 entry, $0.1 current: PnL = pos * (0.0995 - 10) = pos * (-9.9) which is huge loss

    log(`  Notional at $${crashPrice}: ${(Number(notional) / 1e9).toFixed(6)} SOL`);
    log(`  Maintenance req: ${(Number(maintenanceReq) / 1e9).toFixed(6)} SOL`);
  }

  // ===== FINAL STATE =====
  log("\n=== FINAL STATE ===");

  await pushPrice(150);
  for (let i = 0; i < 5; i++) await crank();

  const { vaultBalance: v2, engine: e2, data: data2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;
  const fc2 = Number(e2.lifetimeForceCloses);
  const liq2 = Number(e2.lifetimeLiquidations);

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)} (Δ = ${(v2 - v1).toFixed(6)})`);
  log(`Insurance: ${ins1.toFixed(9)} -> ${ins2.toFixed(9)}`);
  log(`Liquidations: ${liq1} -> ${liq2} (Δ = ${liq2 - liq1})`);
  log(`Force Closes (ADL): ${fc1} -> ${fc2} (Δ = ${fc2 - fc1})`);

  log("\nFinal account states:");
  for (const idx of indices) {
    const acc = parseAccount(data2, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  // ===== ADL VERIFICATION =====
  log("\n=== ADL VERIFICATION ===");

  if (fc2 > fc1) {
    log(`*** ADL VERIFIED: ${fc2 - fc1} force close(s) occurred ***`);
    log("The system correctly used ADL to close positions when insurance/LP couldn't cover bad debt");
  } else if (liq2 > liq1) {
    log(`*** LIQUIDATION occurred: ${liq2 - liq1} liquidation(s) ***`);
    log("Position was closed via liquidation (not ADL)");
  } else {
    const userAcc = parseAccount(data2, userWithPosition);
    if (userAcc.positionSize === 0n) {
      log("Position was closed but counters didn't change - investigate");
    } else {
      log("Position still open - ADL did NOT trigger");
      log("This could mean:");
      log("  1. Position wasn't underwater enough to trigger");
      log("  2. ADL mechanism has different trigger conditions");
      log("  3. Need different test conditions");
    }
  }

  // Solvency check
  log("\n=== SOLVENCY CHECK ===");
  let totalLiabilities = e2.insuranceFund.balance;
  for (const idx of indices) {
    const acc = parseAccount(data2, idx);
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
