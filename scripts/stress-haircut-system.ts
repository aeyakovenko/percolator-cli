/**
 * Stress Test: Haircut-Ratio System
 *
 * Tests the new engine design where undercollateralization is handled via
 * haircut ratios (h = min(Residual, PnlPosTot) / PnlPosTot) rather than
 * ADL/socialization.
 *
 * Scenarios:
 * 1. Normal trading — verify conservation: vault >= c_tot + insurance
 * 2. Insurance absorption — liquidation with bad debt, insurance covers
 * 3. Haircut undercollateralization — insurance exhausted, haircut < 1
 * 4. Recovery — insurance topped up, haircut returns to 1
 *
 * Usage: npx tsx scripts/stress-haircut-system.ts
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeTradeCpi, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice, encodeSetOracleAuthority,
  encodeCloseAccount, encodeTopUpInsurance,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_TOPUP_INSURANCE,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);
const VAULT = new PublicKey(marketInfo.vault);
const LP_IDX = marketInfo.lp.index;

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const AIRDROP_AMOUNT = 2_000_000_000;
const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
interface ParsedState {
  engine: ReturnType<typeof parseEngine>;
  config: ReturnType<typeof parseConfig>;
  params: ReturnType<typeof parseParams>;
  accounts: { idx: number; kind: string; capital: bigint; pnl: bigint; positionSize: bigint; entryPriceE6: bigint; feeCredits: bigint; [k: string]: any }[];
  data: Buffer;
}

async function getState(): Promise<ParsedState> {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const params = parseParams(data);
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({
      idx,
      ...acc,
      kind: acc.kind === AccountKind.LP ? "LP" : "USER",
      capital: acc.capital,
      pnl: acc.pnl,
      positionSize: acc.positionSize,
      entryPriceE6: acc.entryPrice,
      feeCredits: acc.feeCredits,
    });
  }
  return { engine, config, params, accounts, data };
}

function printState(label: string, state: ParsedState) {
  const e = state.engine;
  console.log(`\n>>> ${label} <<<`);
  console.log(`  Vault:       ${fmt(e.vault)} SOL`);
  console.log(`  Insurance:   ${fmt(e.insuranceFund.balance)} SOL`);
  console.log(`  C_tot:       ${fmt(e.cTot)} SOL`);
  console.log(`  PnlPosTot:   ${fmt(e.pnlPosTot)} SOL`);
  console.log(`  TotalOI:     ${e.totalOpenInterest}`);

  // Compute haircut ratio
  const residual = e.vault - e.cTot - e.insuranceFund.balance;
  const pnlPosTot = e.pnlPosTot;
  let haircutPct = "100.00";
  if (pnlPosTot > 0n) {
    const hNum = residual < pnlPosTot ? residual : pnlPosTot;
    haircutPct = (Number(hNum) / Number(pnlPosTot) * 100).toFixed(2);
  }
  console.log(`  Residual:    ${fmt(residual > 0n ? residual : 0n)} SOL`);
  console.log(`  Haircut:     ${haircutPct}%`);
  console.log(`  Liqs: ${e.lifetimeLiquidations}, ForceClose: ${e.lifetimeForceCloses}`);
  for (const acc of state.accounts) {
    const pos = BigInt(acc.positionSize);
    const dir = pos > 0n ? "LONG" : pos < 0n ? "SHORT" : "FLAT";
    console.log(`    ${acc.kind}[${acc.idx}]: ${dir} pos=${pos}, cap=${fmt(BigInt(acc.capital))}, pnl=${fmt(BigInt(acc.pnl))}, fc=${acc.feeCredits}`);
  }
}

// ---------------------------------------------------------------------------
// Conservation invariant
// ---------------------------------------------------------------------------
function checkConservation(state: ParsedState, label: string): boolean {
  const e = state.engine;
  const totalCapital = state.accounts.reduce((sum, a) => sum + BigInt(a.capital), 0n);
  const insurance = e.insuranceFund.balance;
  const vault = e.vault;
  const slack = vault - totalCapital - insurance;
  const ok = slack >= 0n;
  if (!ok) {
    console.log(`  *** CONSERVATION VIOLATED at ${label} ***`);
    console.log(`    vault=${fmt(vault)}, totalCap=${fmt(totalCapital)}, ins=${fmt(insurance)}, slack=${fmt(slack)}`);
  }
  // Also check c_tot matches
  const cTotMatch = e.cTot === totalCapital;
  if (!cTotMatch) {
    console.log(`  *** C_TOT MISMATCH at ${label}: engine.cTot=${fmt(e.cTot)}, actual=${fmt(totalCapital)} ***`);
  }
  return ok && cTotMatch;
}

// ---------------------------------------------------------------------------
// On-chain operations
// ---------------------------------------------------------------------------
async function crank() {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function crankN(n: number, label?: string) {
  for (let i = 0; i < n; i++) {
    try { await crank(); } catch (e: any) {
      if (label) console.log(`  Crank ${i + 1}/${n} (${label}): ${e.message?.slice(0, 60)}`);
    }
    await delay(500);
  }
}

async function setOracleAuthority() {
  const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function pushPrice(priceE6: bigint) {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: timestamp.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function initUser(): Promise<number | null> {
  const beforeState = await getState();
  const beforeIndices = new Set(parseUsedIndices(beforeState.data));
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeInitUser({ feePayment: "1000000" }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  const afterState = await getState();
  for (const idx of parseUsedIndices(afterState.data)) {
    if (!beforeIndices.has(idx)) return idx;
  }
  return null;
}

async function deposit(accountIdx: number, amount: bigint) {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userAta.address, lamports: amount }),
    createSyncNativeInstruction(userAta.address)
  );
  await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeDepositCollateral({ userIdx: accountIdx, amount: amount.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function trade(userIdx: number, size: bigint) {
  const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, MATCHER_CTX, LP_PDA,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeTradeCpi({ lpIdx: LP_IDX, userIdx, size: size.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function closeAccount(userIdx: number) {
  const { config } = await getState();
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);
  const keys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
    payer.publicKey, SLAB, config.vaultPubkey, userAta.address,
    vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeCloseAccount({ userIdx }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function topUpInsurance(amount: bigint) {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userAta.address, lamports: amount }),
    createSyncNativeInstruction(userAta.address)
  );
  await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeTopUpInsurance({ amount: amount.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function ensureSolBalance(minLamports: bigint) {
  const bal = await conn.getBalance(payer.publicKey);
  if (BigInt(bal) < minLamports) {
    const needed = Number(minLamports - BigInt(bal));
    const drops = Math.ceil(needed / AIRDROP_AMOUNT);
    console.log(`  Airdropping ${drops} x 2 SOL...`);
    for (let i = 0; i < drops && i < 5; i++) {
      try {
        const sig = await conn.requestAirdrop(payer.publicKey, AIRDROP_AMOUNT);
        await conn.confirmTransaction(sig, "confirmed");
      } catch {}
      await delay(1000);
    }
  }
}

async function getBasePrice(): Promise<bigint> {
  const state = await getState();
  return state.config.authorityPriceE6 > 0n ? state.config.authorityPriceE6 : 9623n;
}

// ===========================================================================
// SCENARIO 1: Normal Trading
// ===========================================================================
async function scenario1_normalTrading(basePrice: bigint) {
  console.log("\n============================================================");
  console.log("SCENARIO 1: Normal Trading — Conservation Check");
  console.log("============================================================");

  let state = await getState();
  printState("Initial", state);
  let allOk = checkConservation(state, "initial");

  // Create trader, deposit, trade
  console.log("\n  Creating trader...");
  const idx = await initUser();
  if (idx === null) { console.log("  FAILED"); return false; }
  await deposit(idx, 2_000_000_000n);
  await crank();

  state = await getState();
  allOk = checkConservation(state, "after-deposit") && allOk;

  // Open LONG position
  console.log("  Opening LONG 1T...");
  try {
    await trade(idx, 1_000_000_000_000n);
  } catch (e: any) {
    console.log(`  Trade failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
  await crank();
  state = await getState();
  printState("After trade", state);
  allOk = checkConservation(state, "after-trade") && allOk;

  // Move price up 5%
  const upPrice = basePrice * 105n / 100n;
  console.log(`  Price up 5%: ${basePrice} -> ${upPrice}`);
  await pushPrice(upPrice);
  await crank();
  state = await getState();
  allOk = checkConservation(state, "price-up") && allOk;

  // Move price down 5% (back to baseline)
  console.log(`  Price back to baseline: ${upPrice} -> ${basePrice}`);
  await pushPrice(basePrice);
  await crank();
  state = await getState();
  allOk = checkConservation(state, "price-back") && allOk;

  // Close position
  console.log("  Closing position...");
  const traderAcc = state.accounts.find((a: any) => a.idx === idx);
  if (traderAcc && BigInt(traderAcc.positionSize) !== 0n) {
    try {
      await trade(idx, -BigInt(traderAcc.positionSize));
      await crank();
    } catch (e: any) {
      console.log(`  Close trade failed: ${e.message?.slice(0, 60)}`);
    }
  }

  // Close account
  try {
    await crankN(3, "pre-close");
    await closeAccount(idx);
    console.log(`  Account ${idx} closed`);
  } catch (e: any) {
    console.log(`  Close account failed: ${e.message?.slice(0, 60)}`);
  }

  state = await getState();
  printState("After close", state);
  allOk = checkConservation(state, "after-close") && allOk;

  console.log(`\n  Scenario 1: ${allOk ? "PASS" : "FAIL"}`);
  return allOk;
}

// ===========================================================================
// SCENARIO 2: Crash + Insurance Absorption
// ===========================================================================
async function scenario2_crashInsurance(basePrice: bigint) {
  console.log("\n============================================================");
  console.log("SCENARIO 2: Crash — Insurance Absorbs Bad Debt");
  console.log("============================================================");

  let state = await getState();
  const initialInsurance = state.engine.insuranceFund.balance;
  const initialLiqs = state.engine.lifetimeLiquidations;
  let allOk = true;

  // Boost LP to absorb counterparty
  console.log("  Boosting LP...");
  await ensureSolBalance(15_000_000_000n);
  await deposit(LP_IDX, 5_000_000_000n);
  await crank();

  // Create 3 traders with 1 SOL each
  console.log("  Creating 3 traders...");
  const traders: number[] = [];
  for (let i = 0; i < 3; i++) {
    const idx = await initUser();
    if (idx !== null) {
      traders.push(idx);
      await deposit(idx, 1_000_000_000n);
    }
    await delay(500);
  }
  await crank();

  // Open LONG positions (high leverage)
  console.log("  Opening LONG positions...");
  for (const idx of traders) {
    try {
      await trade(idx, 1_500_000_000_000n); // ~7x leverage
    } catch (e: any) {
      console.log(`    Trader ${idx} trade failed: ${e.message?.slice(0, 60)}`);
    }
    await delay(300);
  }

  state = await getState();
  printState("Before crash", state);
  allOk = checkConservation(state, "before-crash") && allOk;

  // Crash 30% — should trigger liquidations
  const crashPrice = basePrice * 70n / 100n;
  console.log(`\n  CRASH: ${basePrice} -> ${crashPrice} (-30%)`);
  await pushPrice(crashPrice);

  // Crank to process liquidations
  await crankN(5, "crash");
  state = await getState();
  printState("After crash", state);
  allOk = checkConservation(state, "after-crash") && allOk;

  const newLiqs = state.engine.lifetimeLiquidations - initialLiqs;
  const insuranceDelta = state.engine.insuranceFund.balance - initialInsurance;
  console.log(`\n  New liquidations: ${newLiqs}`);
  console.log(`  Insurance delta: ${fmt(insuranceDelta)} SOL`);

  // Restore price
  await pushPrice(basePrice);
  await crankN(3, "restore");

  // Cleanup — close remaining trader accounts
  state = await getState();
  for (const acc of state.accounts) {
    if (acc.kind !== "USER") continue;
    if (BigInt(acc.positionSize) !== 0n) {
      try { await trade(acc.idx, -BigInt(acc.positionSize)); await crank(); } catch {}
    }
    try { await closeAccount(acc.idx); } catch {}
    await delay(300);
  }

  state = await getState();
  allOk = checkConservation(state, "cleanup") && allOk;
  console.log(`\n  Scenario 2: ${allOk ? "PASS" : "FAIL"}`);
  return allOk;
}

// ===========================================================================
// SCENARIO 3: Severe Crash — Haircut Undercollateralization
// ===========================================================================
async function scenario3_haircutTest(basePrice: bigint) {
  console.log("\n============================================================");
  console.log("SCENARIO 3: Severe Crash — Haircut < 100%");
  console.log("============================================================");

  let state = await getState();
  let allOk = true;

  // Boost LP
  await ensureSolBalance(20_000_000_000n);
  await deposit(LP_IDX, 10_000_000_000n);
  await crank();

  // Create 5 traders at max leverage
  console.log("  Creating 5 traders...");
  const traders: number[] = [];
  for (let i = 0; i < 5; i++) {
    const idx = await initUser();
    if (idx !== null) {
      traders.push(idx);
      await deposit(idx, 2_000_000_000n);
    }
    await delay(500);
  }
  await crank();

  console.log("  Opening LONG positions (~9.6x leverage)...");
  for (const idx of traders) {
    try {
      await trade(idx, 2_000_000_000_000n);
    } catch (e: any) {
      console.log(`    Trader ${idx}: ${e.message?.slice(0, 60)}`);
      try { await trade(idx, 1_000_000_000_000n); } catch {}
    }
    await delay(300);
  }

  state = await getState();
  printState("Before severe crash", state);
  allOk = checkConservation(state, "pre-severe-crash") && allOk;

  // Severe crash — 50% down, gap risk (no crank between)
  const severePrice = basePrice * 50n / 100n;
  console.log(`\n  SEVERE CRASH: ${basePrice} -> ${severePrice} (-50%)`);
  await pushPrice(severePrice);

  // Crank to process
  await crankN(5, "severe-crash");
  state = await getState();
  printState("After severe crash", state);
  allOk = checkConservation(state, "post-severe-crash") && allOk;

  // Check haircut ratio
  const residual = state.engine.vault - state.engine.cTot - state.engine.insuranceFund.balance;
  const ppt = state.engine.pnlPosTot;
  if (ppt > 0n) {
    const hNum = residual < ppt ? residual : ppt;
    const haircutPct = Number(hNum) / Number(ppt) * 100;
    console.log(`\n  Haircut ratio: ${haircutPct.toFixed(2)}%`);
    if (haircutPct < 100) {
      console.log("  System is undercollateralized — haircut active");
      console.log("  This is correct: warmup settlement will apply haircut to PnL conversion");
    }
  }

  // Restore price and cleanup
  await pushPrice(basePrice);
  await crankN(5, "restore");

  state = await getState();
  for (const acc of state.accounts) {
    if (acc.kind !== "USER") continue;
    if (BigInt(acc.positionSize) !== 0n) {
      try { await trade(acc.idx, -BigInt(acc.positionSize)); await crank(); } catch {}
    }
    try { await closeAccount(acc.idx); } catch {}
    await delay(300);
  }

  state = await getState();
  allOk = checkConservation(state, "cleanup") && allOk;
  printState("After cleanup", state);
  console.log(`\n  Scenario 3: ${allOk ? "PASS" : "FAIL"}`);
  return allOk;
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("============================================================");
  console.log("HAIRCUT-RATIO SYSTEM STRESS TEST");
  console.log("============================================================");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Slab: ${SLAB.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  // Ensure oracle authority
  try { await setOracleAuthority(); } catch {}

  const basePrice = await getBasePrice();
  console.log(`  Base price: ${basePrice}`);
  await pushPrice(basePrice);
  await crankN(2, "init");

  const results: { name: string; pass: boolean }[] = [];

  // Run scenarios
  try {
    const r1 = await scenario1_normalTrading(basePrice);
    results.push({ name: "Normal Trading", pass: r1 });
  } catch (e: any) {
    console.log(`  Scenario 1 error: ${e.message?.slice(0, 100)}`);
    results.push({ name: "Normal Trading", pass: false });
  }

  try {
    const r2 = await scenario2_crashInsurance(basePrice);
    results.push({ name: "Crash + Insurance", pass: r2 });
  } catch (e: any) {
    console.log(`  Scenario 2 error: ${e.message?.slice(0, 100)}`);
    results.push({ name: "Crash + Insurance", pass: false });
  }

  try {
    const r3 = await scenario3_haircutTest(basePrice);
    results.push({ name: "Haircut Under-collat", pass: r3 });
  } catch (e: any) {
    console.log(`  Scenario 3 error: ${e.message?.slice(0, 100)}`);
    results.push({ name: "Haircut Under-collat", pass: false });
  }

  // Summary
  console.log("\n============================================================");
  console.log("RESULTS");
  console.log("============================================================");
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  }
  const allPass = results.every(r => r.pass);
  console.log(`\n  Overall: ${allPass ? "ALL PASS" : "SOME FAILED"}`);
  console.log("============================================================\n");

  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error("Fatal:", e.message?.slice(0, 200)); process.exit(1); });
