/**
 * Test ADL with Fresh Position
 *
 * To properly test ADL:
 * 1. Fund LP with capital
 * 2. Open a leveraged position at current price
 * 3. Crash price to make position underwater
 * 4. Verify liquidation or ADL triggers
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, parseParams, AccountKind } from "../src/solana/slab.js";
import { encodeDepositCollateral, encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeLiquidateAtOracle } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_LIQUIDATE_AT_ORACLE } from "../src/abi/accounts.js";
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

async function depositToLP(amountLamports: bigint): Promise<boolean> {
  await delay();
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const depositData = encodeDepositCollateral({ userIdx: LP_IDX, amount: amountLamports.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
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

async function main() {
  log("=== ADL TEST WITH FRESH POSITION ===\n");

  // Initial state
  const { vaultBalance: v1, engine: e1, data: data1 } = await getState();
  const fc1 = Number(e1.lifetimeForceCloses);
  const liq1 = Number(e1.lifetimeLiquidations);

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Lifetime Liquidations: ${liq1}`);
  log(`  Lifetime Force Closes (ADL): ${fc1}`);

  // Step 1: Fund LP
  log("\n=== STEP 1: Fund LP ===");
  log("Depositing 0.2 SOL to LP...");
  const funded = await depositToLP(200_000_000n);
  if (!funded) {
    log("Failed to fund LP");
    return;
  }
  await crank();

  const { data: data2 } = await getState();
  const lpAcc = parseAccount(data2, 0);
  log(`LP capital after deposit: ${(Number(lpAcc.capital) / 1e9).toFixed(6)} SOL`);

  // Step 2: Set price and open leveraged position on User 1
  log("\n=== STEP 2: Open Leveraged Position ===");
  await pushPrice(150);
  await crank();

  // User 1 has ~2 SOL capital - try to open a large LONG position
  // With 10% initial margin, they could open ~20 SOL notional worth
  // position_size = notional * 1e6 / price_e6
  // For 2 SOL notional at $150: position_size = 2 * 1e6 * 1e6 / 150e6 = 13,333,333 units

  log("Opening large LONG position on User 1 (10M units)...");
  const tradeResult = await trade(1, 0, 10_000_000n);
  log(`Trade result: ${tradeResult ? "SUCCESS" : "FAILED"}`);

  if (!tradeResult) {
    log("Cannot open position - checking alternative...");
    // Try smaller position
    log("Trying smaller position (1M units)...");
    const tradeResult2 = await trade(1, 0, 1_000_000n);
    log(`Trade result: ${tradeResult2 ? "SUCCESS" : "FAILED"}`);
  }

  await crank();

  const { data: data3, engine: e3 } = await getState();
  const user1After = parseAccount(data3, 1);
  log(`User 1 position: ${user1After.positionSize} at $${(Number(user1After.entryPrice) / 1e6).toFixed(2)}`);

  if (user1After.positionSize === 0n) {
    log("No position opened - cannot test ADL");
    return;
  }

  // Step 3: Crash price to make position underwater
  log("\n=== STEP 3: Crash Price ===");

  // For a LONG in inverted market:
  // PnL is calculated when the position is closed
  // The unrealized PnL affects margin calculations

  const crashPrices = [100, 50, 30, 20, 10, 5, 1];
  for (const price of crashPrices) {
    log(`\nCrashing to $${price}...`);
    await pushPrice(price);

    // Heavy cranking to process any liquidations
    for (let i = 0; i < 10; i++) {
      await crank();
    }

    // Try explicit liquidation
    await liquidate(1, 0);

    const { engine, data } = await getState();
    const user1Now = parseAccount(data, 1);

    log(`  Position: ${user1Now.positionSize}`);
    log(`  Liquidations: ${liq1} -> ${engine.lifetimeLiquidations}`);
    log(`  Force Closes: ${fc1} -> ${engine.lifetimeForceCloses}`);

    if (user1Now.positionSize === 0n) {
      log(`\n*** POSITION CLOSED! ***`);
      if (Number(engine.lifetimeForceCloses) > fc1) {
        log(`*** ADL VERIFIED: Force close count increased! ***`);
      }
      if (Number(engine.lifetimeLiquidations) > liq1) {
        log(`*** LIQUIDATION VERIFIED: Liquidation count increased! ***`);
      }
      break;
    }
  }

  // Final state
  log("\n=== FINAL STATE ===");
  const { vaultBalance: v2, engine: e2, data: data4 } = await getState();
  const fc2 = Number(e2.lifetimeForceCloses);
  const liq2 = Number(e2.lifetimeLiquidations);

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)}`);
  log(`Liquidations: ${liq1} -> ${liq2} (Δ = ${liq2 - liq1})`);
  log(`Force Closes: ${fc1} -> ${fc2} (Δ = ${fc2 - fc1})`);

  log("\nAccounts:");
  for (const idx of parseUsedIndices(data4)) {
    const acc = parseAccount(data4, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  // Verification
  log("\n=== ADL/LIQUIDATION VERIFICATION ===");
  if (fc2 > fc1) {
    log(`*** ADL CONFIRMED: ${fc2 - fc1} force close(s) ***`);
  } else if (liq2 > liq1) {
    log(`*** LIQUIDATION CONFIRMED: ${liq2 - liq1} liquidation(s) ***`);
  } else {
    log("Neither ADL nor liquidation triggered in this test");
  }

  // Reset price
  await pushPrice(150);
  await crank();
}

main().catch(console.error);
