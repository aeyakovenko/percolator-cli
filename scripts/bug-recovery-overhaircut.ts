/**
 * Bug Reproduction: Recovery Over-Haircut
 *
 * `recover_stranded_to_insurance()` computes:
 *   total_needed = stranded + loss_accum ≈ Σpnl
 * then:
 *   haircut = min(total_needed, total_positive_pnl) = total_positive_pnl
 *
 * This wipes 100% of LP's PnL. The LP's legitimate profit (pnl - loss_accum)
 * is confiscated into insurance.
 *
 * Expected: LP retains (pnl - loss_accum) after recovery.
 * Actual:   LP.pnl → 0, insurance absorbs everything including legitimate profit.
 *
 * Evidence from stress test run 3:
 *   Crank 1: lossAccum=37.450646, ins=0.005021, rr=true   ← socialization
 *   Crank 2: lossAccum=0.000000,  ins=10.922609, rr=false  ← recovery wiped LP PnL to 0
 *   LP should have retained ~10.67 SOL of legitimate profit.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice, encodeSetOracleAuthority,
  encodeCloseAccount, encodeTopUpInsurance,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
interface ParsedState {
  engine: ReturnType<typeof parseEngine>;
  config: ReturnType<typeof parseConfig>;
  params: ReturnType<typeof parseParams>;
  accounts: { idx: number; kind: string; capital: bigint; pnl: bigint; positionSize: bigint; entryPriceE6: bigint; [k: string]: any }[];
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
    });
  }
  return { engine, config, params, accounts, data };
}

function printState(label: string, state: ParsedState) {
  const e = state.engine;
  console.log(`\n>>> ${label} <<<`);
  console.log(`  Vault:       ${fmt(e.vault)} SOL`);
  console.log(`  Insurance:   ${fmt(e.insuranceFund.balance)} SOL`);
  console.log(`  LossAccum:   ${fmt(e.lossAccum)} SOL`);
  console.log(`  RiskReduce:  ${e.riskReductionOnly}`);
  console.log(`  TotalOI:     ${e.totalOpenInterest}`);
  console.log(`  Liqs: ${e.lifetimeLiquidations}, ForceClose: ${e.lifetimeForceCloses}`);
  for (const acc of state.accounts) {
    const pos = BigInt(acc.positionSize);
    const dir = pos > 0n ? "LONG" : pos < 0n ? "SHORT" : "FLAT";
    console.log(`    ${acc.kind}[${acc.idx}]: ${dir} pos=${pos}, cap=${fmt(BigInt(acc.capital))}, pnl=${fmt(BigInt(acc.pnl))}`);
  }
}

// ---------------------------------------------------------------------------
// On-chain operations
// ---------------------------------------------------------------------------
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

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

// ---------------------------------------------------------------------------
// Reusable helpers
// ---------------------------------------------------------------------------

async function ensureSolBalance(minLamports: bigint) {
  const bal = await conn.getBalance(payer.publicKey);
  if (BigInt(bal) < minLamports) {
    const needed = Number(minLamports - BigInt(bal));
    const drops = Math.ceil(needed / AIRDROP_AMOUNT);
    console.log(`  Payer balance low (${(bal / 1e9).toFixed(3)} SOL), requesting ${drops} airdrop(s)...`);
    for (let i = 0; i < drops && i < 5; i++) {
      try {
        const sig = await conn.requestAirdrop(payer.publicKey, AIRDROP_AMOUNT);
        await conn.confirmTransaction(sig, "confirmed");
        console.log(`    Airdrop ${i + 1} confirmed`);
      } catch (e: any) {
        console.log(`    Airdrop ${i + 1} failed: ${e.message?.slice(0, 50)}`);
      }
      await delay(1000);
    }
    const newBal = await conn.getBalance(payer.publicKey);
    console.log(`  Payer balance now: ${(newBal / 1e9).toFixed(3)} SOL`);
  }
}

async function ensureOracleAuthority() {
  try {
    await setOracleAuthority();
    console.log("  Oracle authority set to admin");
  } catch (e: any) {
    console.log(`  Oracle authority already set or error: ${e.message?.slice(0, 50)}`);
  }
}

async function createTraders(n: number): Promise<number[]> {
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    console.log(`  Creating trader ${i + 1}/${n}...`);
    const idx = await initUser();
    if (idx === null) { console.log("    FAILED to create"); continue; }
    indices.push(idx);
    console.log(`    Created index ${idx}`);
    await delay(500);
  }
  return indices;
}

async function fundTraders(indices: number[], amount: bigint) {
  for (const idx of indices) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`  Depositing ${fmt(amount)} SOL to trader ${idx}${attempt > 0 ? ` (retry ${attempt})` : ""}...`);
        await deposit(idx, amount);
        break;
      } catch (e: any) {
        console.log(`    Failed: ${e.message?.slice(0, 60)}`);
        if (attempt < 2) await delay(2000);
      }
    }
    await delay(1000);
  }
}

async function openPositions(indices: number[], size: bigint): Promise<number> {
  let ok = 0;
  for (const idx of indices) {
    try {
      const dir = size > 0n ? "LONG" : "SHORT";
      console.log(`  Trader ${idx}: opening ${dir} ${size}...`);
      await trade(idx, size);
      ok++;
    } catch (e: any) {
      console.log(`    Failed: ${e.message?.slice(0, 80)}`);
      try {
        const half = size / 2n;
        console.log(`    Retrying half size ${half}...`);
        await trade(idx, half);
        ok++;
      } catch (e2: any) {
        console.log(`    Half also failed: ${e2.message?.slice(0, 60)}`);
      }
    }
    await delay(500);
  }
  console.log(`  ${ok}/${indices.length} trades executed`);
  return ok;
}

async function getBasePrice(): Promise<bigint> {
  const state = await getState();
  return state.config.authorityPriceE6 > 0n ? state.config.authorityPriceE6 : 9623n;
}

async function resetMarket() {
  console.log("\n  --- Resetting market to clean state ---");
  const basePrice = await getBasePrice();
  await pushPrice(basePrice);
  await crankN(3, "reset");

  let state = await getState();

  // Exit risk-reduction if active
  if (state.engine.riskReductionOnly) {
    const lossAccum = state.engine.lossAccum;
    const threshold = state.params.riskReductionThreshold;
    if (lossAccum > 0n) {
      const topUp = lossAccum + threshold + 2_000_000_000n;
      console.log(`  Exiting risk-reduction via topUpInsurance (${fmt(topUp)} SOL)...`);
      await ensureSolBalance(topUp + 1_000_000_000n);
      try {
        await topUpInsurance(topUp);
        await crankN(3, "reset-rr-exit");
        state = await getState();
        console.log(`  Risk-reduction: ${state.engine.riskReductionOnly}, lossAccum: ${fmt(state.engine.lossAccum)}`);
      } catch (e: any) {
        console.log(`  TopUpInsurance failed: ${e.message?.slice(0, 60)}`);
      }
    } else {
      await crankN(5, "reset-rr-clear");
      state = await getState();
    }
  }

  // Flatten LP position if it has one
  const lp = state.accounts.find((a: any) => a.kind === "LP");
  if (lp && BigInt(lp.positionSize) !== 0n) {
    const lpPos = BigInt(lp.positionSize);
    console.log(`  LP has position ${lpPos}, flattening with temp trader...`);
    await ensureSolBalance(10_000_000_000n);
    const tmpIdx = await initUser();
    if (tmpIdx !== null) {
      try {
        await deposit(tmpIdx, 5_000_000_000n);
        await trade(tmpIdx, lpPos);
        console.log(`  LP flattened`);
        await crank();
      } catch (e: any) {
        console.log(`  Flatten failed: ${e.message?.slice(0, 60)}`);
      }
      state = await getState();
      const tmpAcc = state.accounts.find((a: any) => a.idx === tmpIdx);
      if (tmpAcc && BigInt(tmpAcc.positionSize) !== 0n) {
        try {
          await trade(tmpIdx, -BigInt(tmpAcc.positionSize));
          await crank();
        } catch (e: any) {
          console.log(`  Temp trader close failed: ${e.message?.slice(0, 60)}`);
        }
      }
      try { await closeAccount(tmpIdx); } catch {}
    }
  }

  // Close ALL user accounts (flatten positions first, then close)
  state = await getState();
  for (const acc of state.accounts) {
    if (acc.kind !== "USER") continue;
    const pos = BigInt(acc.positionSize);
    const cap = BigInt(acc.capital);
    if (pos !== 0n) {
      // Flatten position by trading opposite
      console.log(`  Flattening USER[${acc.idx}] pos=${pos}...`);
      try {
        await trade(acc.idx, -pos);
        await crank();
        console.log(`    Flattened`);
      } catch (e: any) {
        console.log(`    Flatten failed: ${e.message?.slice(0, 60)}`);
        continue; // can't close if still has position
      }
      await delay(500);
    }
    // Now close account (withdraw capital + remove)
    try {
      await closeAccount(acc.idx);
      console.log(`  Closed account ${acc.idx}`);
    } catch (e: any) {
      console.log(`  Close account ${acc.idx} failed: ${e.message?.slice(0, 60)}`);
    }
    await delay(500);
  }

  await crankN(2, "reset-final");
  state = await getState();
  printState("Market after reset", state);
  return state;
}

// ===========================================================================
// BUG REPRODUCTION: Recovery Over-Haircut
// ===========================================================================
async function reproduceOverHaircut() {
  console.log("\n============================================================");
  console.log("BUG REPRODUCTION: Recovery Over-Haircut");
  console.log("============================================================");
  console.log("  recover_stranded_to_insurance() haircuts 100% of LP PnL,");
  console.log("  confiscating legitimate profit (pnl - loss_accum) into insurance.");
  console.log("============================================================");

  const basePrice = await getBasePrice();
  console.log(`  Base price: ${basePrice}`);

  // ------------------------------------------------------------------
  // Step 1: Reset market — clean state
  // ------------------------------------------------------------------
  console.log("\n=== Step 1: Reset market ===");
  await resetMarket();

  let state = await getState();
  if (state.engine.riskReductionOnly) {
    console.log("  ERROR: Market stuck in risk-reduction after reset, cannot proceed.");
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Step 2: Check insurance and scale parameters
  // ------------------------------------------------------------------
  console.log("\n=== Step 2: Check insurance level and scale parameters ===");
  state = await getState();
  const insuranceBefore = state.engine.insuranceFund.balance;
  console.log(`  Current insurance: ${fmt(insuranceBefore)} SOL`);

  // Scale number of traders to ensure bad debt overwhelms insurance.
  // Each trader: 2 SOL collateral, 2T LONG at ~9.6x leverage.
  // At 50% crash: each trader's loss ≈ 2T * 4811/1e6 ≈ 9.6 SOL, bad debt ≈ 7.7 SOL.
  // Need: total_bad_debt > insurance → num_traders > insurance / 7.7
  const estBadDebtPerTrader = 7_700_000_000n; // ~7.7 SOL per trader
  const minTraders = Number(insuranceBefore / estBadDebtPerTrader) + 3; // +3 for margin
  const NUM_TRADERS = Math.max(5, Math.min(minTraders, 15)); // clamp 5..15
  console.log(`  Estimated bad debt per trader: ~${fmt(estBadDebtPerTrader)} SOL`);
  console.log(`  Traders needed to overwhelm insurance: ${minTraders}`);
  console.log(`  Using ${NUM_TRADERS} traders`);

  // ------------------------------------------------------------------
  // Step 3: Setup — N traders (2 SOL each), LP boosted, LONG
  // ------------------------------------------------------------------
  console.log(`\n=== Step 3: Setup ${NUM_TRADERS} traders + LP boost ===`);
  const LP_BOOST = 10_000_000_000n;
  const TRADER_DEPOSIT = 2_000_000_000n;
  const totalNeeded = LP_BOOST + TRADER_DEPOSIT * BigInt(NUM_TRADERS) + 5_000_000_000n; // + buffer
  await ensureSolBalance(totalNeeded);

  // Boost LP
  try {
    await deposit(LP_IDX, LP_BOOST);
    console.log(`  LP boosted by ${fmt(LP_BOOST)} SOL`);
  } catch (e: any) {
    console.log(`  LP boost failed: ${e.message?.slice(0, 60)}`);
  }
  await crank();

  // Create and fund traders
  const traders = await createTraders(NUM_TRADERS);
  await fundTraders(traders, TRADER_DEPOSIT);
  await crank();

  // Open LONG positions — 2T units each (~9.6x leverage)
  console.log("\n  --- Opening LONG positions ---");
  const TRADE_SIZE = 2_000_000_000_000n;
  const opened = await openPositions(traders, TRADE_SIZE);
  if (opened === 0) {
    console.log("  ERROR: No positions opened, cannot reproduce bug.");
    process.exit(1);
  }

  // DO NOT crank — positions must exist when price gaps
  state = await getState();
  printState("Step 3: Positions open (before crash)", state);

  const initialLiqs = state.engine.lifetimeLiquidations;

  // ------------------------------------------------------------------
  // Step 4: Crash — gap price 50% down WITHOUT cranking
  // ------------------------------------------------------------------
  console.log("\n=== Step 4: GAP CRASH 50% down ===");
  const crashPrice = basePrice * 50n / 100n;
  console.log(`  Price: ${basePrice} -> ${crashPrice}`);
  await pushPrice(crashPrice);

  // ------------------------------------------------------------------
  // Step 5: Crank ONCE — liquidation cascade + LP force-close
  // ------------------------------------------------------------------
  console.log("\n=== Step 5: Crank ONCE (liquidation + socialization) ===");
  try {
    await crank();
    console.log("  Crank 1 succeeded");
  } catch (e: any) {
    console.log(`  Crank 1 failed: ${e.message?.slice(0, 80)}`);
    // Try again — sometimes first crank partially processes
    await delay(1000);
    try {
      await crank();
      console.log("  Crank 1 retry succeeded");
    } catch (e2: any) {
      console.log(`  Crank 1 retry also failed: ${e2.message?.slice(0, 80)}`);
    }
  }
  await delay(500);

  // ------------------------------------------------------------------
  // Step 6: Capture pre_recovery state
  // ------------------------------------------------------------------
  console.log("\n=== Step 6: Capture pre_recovery state ===");
  state = await getState();
  printState("PRE-RECOVERY", state);

  const preRecovery = {
    lossAccum: state.engine.lossAccum,
    insurance: state.engine.insuranceFund.balance,
    vault: state.engine.vault,
    riskReduction: state.engine.riskReductionOnly,
    totalOI: state.engine.totalOpenInterest,
    lpPnl: 0n,
    lpCapital: 0n,
    totalPositivePnl: 0n,
    totalCapital: 0n,
  };

  for (const acc of state.accounts) {
    const pnl = BigInt(acc.pnl);
    const cap = BigInt(acc.capital);
    preRecovery.totalCapital += cap;
    if (pnl > 0n) preRecovery.totalPositivePnl += pnl;
    if (acc.kind === "LP") {
      preRecovery.lpPnl = pnl;
      preRecovery.lpCapital = cap;
    }
  }

  console.log(`\n  Pre-recovery snapshot:`);
  console.log(`    LP PnL:            ${fmt(preRecovery.lpPnl)} SOL`);
  console.log(`    LP Capital:        ${fmt(preRecovery.lpCapital)} SOL`);
  console.log(`    LossAccum:         ${fmt(preRecovery.lossAccum)} SOL`);
  console.log(`    Insurance:         ${fmt(preRecovery.insurance)} SOL`);
  console.log(`    Vault:             ${fmt(preRecovery.vault)} SOL`);
  console.log(`    TotalPositivePnl:  ${fmt(preRecovery.totalPositivePnl)} SOL`);
  console.log(`    TotalCapital:      ${fmt(preRecovery.totalCapital)} SOL`);
  console.log(`    RiskReduction:     ${preRecovery.riskReduction}`);
  console.log(`    TotalOI:           ${preRecovery.totalOI}`);

  // Check if socialization actually occurred
  if (preRecovery.lossAccum === 0n) {
    console.log("\n  *** NO SOCIALIZATION OCCURRED ***");
    console.log("  Insurance absorbed all losses. The over-haircut bug requires socialization.");
    console.log("  This test is INCONCLUSIVE — try with smaller insurance or larger crash.");
    // Still crank to show what happens, but mark inconclusive
  }

  // ------------------------------------------------------------------
  // Step 7: Calculate expected legitimate profit
  // ------------------------------------------------------------------
  console.log("\n=== Step 7: Calculate expected ===");
  const legitimateProfit = preRecovery.lpPnl > preRecovery.lossAccum
    ? preRecovery.lpPnl - preRecovery.lossAccum
    : 0n;
  const expectedLpPnl = legitimateProfit;
  console.log(`  legitimate_profit = lp_pnl - loss_accum`);
  console.log(`                    = ${fmt(preRecovery.lpPnl)} - ${fmt(preRecovery.lossAccum)}`);
  console.log(`                    = ${fmt(legitimateProfit)} SOL`);
  console.log(`  Expected LP PnL after correct recovery: ${fmt(expectedLpPnl)} SOL`);

  // ------------------------------------------------------------------
  // Step 8: Crank ONCE more — recovery triggers
  // ------------------------------------------------------------------
  console.log("\n=== Step 8: Crank ONCE more (recovery) ===");
  try {
    await crank();
    console.log("  Crank 2 (recovery) succeeded");
  } catch (e: any) {
    console.log(`  Crank 2 failed: ${e.message?.slice(0, 80)}`);
    // Retry
    await delay(1000);
    try {
      await crank();
      console.log("  Crank 2 retry succeeded");
    } catch (e2: any) {
      console.log(`  Crank 2 retry failed: ${e2.message?.slice(0, 80)}`);
      // Crank a few more times in case recovery needs multiple cranks
      await crankN(3, "recovery-extra");
    }
  }
  await delay(500);

  // ------------------------------------------------------------------
  // Step 9: Capture post_recovery state
  // ------------------------------------------------------------------
  console.log("\n=== Step 9: Capture post_recovery state ===");
  state = await getState();
  printState("POST-RECOVERY", state);

  const postRecovery = {
    lossAccum: state.engine.lossAccum,
    insurance: state.engine.insuranceFund.balance,
    vault: state.engine.vault,
    riskReduction: state.engine.riskReductionOnly,
    totalOI: state.engine.totalOpenInterest,
    lpPnl: 0n,
    lpCapital: 0n,
  };

  for (const acc of state.accounts) {
    if (acc.kind === "LP") {
      postRecovery.lpPnl = BigInt(acc.pnl);
      postRecovery.lpCapital = BigInt(acc.capital);
    }
  }

  console.log(`\n  Post-recovery snapshot:`);
  console.log(`    LP PnL:        ${fmt(postRecovery.lpPnl)} SOL`);
  console.log(`    LP Capital:    ${fmt(postRecovery.lpCapital)} SOL`);
  console.log(`    LossAccum:     ${fmt(postRecovery.lossAccum)} SOL`);
  console.log(`    Insurance:     ${fmt(postRecovery.insurance)} SOL`);
  console.log(`    RiskReduction: ${postRecovery.riskReduction}`);

  // ------------------------------------------------------------------
  // Step 10: Report the bug
  // ------------------------------------------------------------------
  console.log("\n============================================================");
  console.log("BUG REPORT: Recovery Over-Haircut");
  console.log("============================================================");

  if (preRecovery.lossAccum === 0n) {
    console.log("\n  INCONCLUSIVE: No socialization occurred (lossAccum=0).");
    console.log("  Insurance was large enough to absorb all losses.");
    console.log("  Rerun with smaller insurance to trigger the bug.");
    console.log("============================================================\n");
    return;
  }

  const confiscatedProfit = expectedLpPnl - postRecovery.lpPnl;
  const insuranceDelta = postRecovery.insurance - preRecovery.insurance;

  console.log(`\n  Pre-recovery LP PnL:     ${fmt(preRecovery.lpPnl)} SOL`);
  console.log(`  Pre-recovery LossAccum:  ${fmt(preRecovery.lossAccum)} SOL`);
  console.log(`  Expected LP PnL:         ${fmt(expectedLpPnl)} SOL  (pnl - loss_accum)`);
  console.log(`  Actual LP PnL:           ${fmt(postRecovery.lpPnl)} SOL`);
  console.log(`  Confiscated profit:      ${fmt(confiscatedProfit)} SOL`);
  console.log(`  Insurance delta:         +${fmt(insuranceDelta)} SOL`);

  // Check if the bug manifested
  const isBuggy = postRecovery.lpPnl === 0n && expectedLpPnl > 1_000_000n; // >0.001 SOL expected
  const isPartial = postRecovery.lpPnl < expectedLpPnl && postRecovery.lpPnl > 0n;

  if (isBuggy) {
    console.log(`\n  *** BUG CONFIRMED ***`);
    console.log(`  LP PnL was wiped to ZERO by recover_stranded_to_insurance().`);
    console.log(`  LP's legitimate profit of ${fmt(confiscatedProfit)} SOL was confiscated into insurance.`);
    console.log(`\n  Root cause:`);
    console.log(`    recover_stranded_to_insurance() computes:`);
    console.log(`      total_needed = stranded + loss_accum`);
    console.log(`      haircut = min(total_needed, total_positive_pnl) = total_positive_pnl`);
    console.log(`    This wipes 100% of positive PnL, not just the socialized loss portion.`);
    console.log(`\n  Correct behavior:`);
    console.log(`    haircut should be limited to loss_accum (the socialized loss portion)`);
    console.log(`    LP should retain: pnl - loss_accum = ${fmt(expectedLpPnl)} SOL`);
  } else if (isPartial) {
    console.log(`\n  *** PARTIAL BUG ***`);
    console.log(`  LP retained some PnL but less than expected.`);
    console.log(`  Expected: ${fmt(expectedLpPnl)}, Got: ${fmt(postRecovery.lpPnl)}`);
    console.log(`  Confiscated: ${fmt(confiscatedProfit)} SOL`);
  } else if (preRecovery.lossAccum > 0n && postRecovery.lpPnl >= expectedLpPnl) {
    console.log(`\n  *** BUG NOT REPRODUCED ***`);
    console.log(`  LP retained expected PnL. Recovery may have been fixed.`);
  } else {
    console.log(`\n  *** UNEXPECTED STATE ***`);
    console.log(`  Review the numbers above manually.`);
  }

  // Cross-check: did insurance receive the confiscated amount?
  if (isBuggy && insuranceDelta > 0n) {
    const confiscatedMatchesInsurance = confiscatedProfit > 0n &&
      (insuranceDelta >= confiscatedProfit - 1_000_000n); // 0.001 SOL tolerance
    console.log(`\n  Insurance received confiscated amount: ${confiscatedMatchesInsurance ? "YES" : "PARTIAL"}`);
    console.log(`    Confiscated:      ${fmt(confiscatedProfit)} SOL`);
    console.log(`    Insurance gained: ${fmt(insuranceDelta)} SOL`);
  }

  console.log("\n============================================================");
  console.log("END BUG REPORT");
  console.log("============================================================\n");

  // Exit with code 1 if bug confirmed (it's the expected result for this reproduction)
  if (isBuggy) {
    console.log("Exiting with code 0 (bug successfully reproduced as expected).");
    process.exit(0);
  }
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("============================================================");
  console.log("RECOVERY OVER-HAIRCUT BUG REPRODUCTION");
  console.log("============================================================");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Slab: ${SLAB.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  await ensureOracleAuthority();
  await reproduceOverHaircut();
}

main().catch(e => { console.error("Fatal:", e.message?.slice(0, 200)); process.exit(1); });
