/**
 * Bug Reproduction: Finding L — Trade uses maintenance_margin_bps instead of initial_margin_bps
 *
 * execute_trade() checks post-trade collateralization against maintenance_margin_bps (5%)
 * instead of initial_margin_bps (10%). This lets users open positions at 20x leverage
 * instead of the intended 10x.
 *
 * Test:
 *   1. Deposit small capital (0.05 SOL)
 *   2. Attempt trade at ~15x leverage (between 10x and 20x)
 *      - Should FAIL if checked against initial_margin_bps (10% = max 10x)
 *      - Will SUCCEED because checked against maintenance_margin_bps (5% = max 20x)
 *   3. Attempt trade at ~25x leverage (above 20x)
 *      - Should FAIL (above even maintenance margin)
 *   4. Compare with withdrawal path which correctly uses initial_margin_bps
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice, encodeCloseAccount,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_CLOSE_ACCOUNT,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import * as fs from "fs";

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

const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const params = parseParams(data);
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({ idx, ...acc, kind: acc.kind === AccountKind.LP ? "LP" : "USER" });
  }
  return { engine, config, params, accounts, data };
}

async function crank() {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
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
  const before = new Set(parseUsedIndices((await getState()).data));
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeInitUser({ feePayment: "1000000" }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  for (const idx of parseUsedIndices((await getState()).data)) {
    if (!before.has(idx)) return idx;
  }
  return null;
}

async function deposit(accountIdx: number, amount: bigint) {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const ataBalance = BigInt((await conn.getTokenAccountBalance(userAta.address)).value.amount);
  if (ataBalance < amount) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userAta.address, lamports: amount }),
      createSyncNativeInstruction(userAta.address)
    );
    await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  }
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

async function main() {
  console.log("============================================================");
  console.log("Bug Reproduction: Finding L — Margin Check Uses maintenance_margin_bps");
  console.log("============================================================");

  const state = await getState();
  const basePrice = state.config.lastEffectivePriceE6;
  console.log(`  Price: ${basePrice}`);
  console.log(`  maintenance_margin_bps: ${state.params.maintenanceMarginBps} (${Number(state.params.maintenanceMarginBps) / 100}%)`);
  console.log(`  initial_margin_bps: ${state.params.initialMarginBps} (${Number(state.params.initialMarginBps) / 100}%)`);

  await pushPrice(basePrice);
  await crank();

  const DEPOSIT = 50_000_000n; // 0.05 SOL

  const idx = await initUser();
  if (idx === null) { console.log("FATAL: account creation failed"); return; }
  await deposit(idx, DEPOSIT);

  // After fees, capital is slightly less than deposit
  let s = await getState();
  let acc = s.accounts.find((a: any) => a.idx === idx);
  const capital = BigInt(acc.capital);
  console.log(`\n  Deposited: ${fmt(DEPOSIT)}, capital after fees: ${fmt(capital)}`);

  // Calculate leverage levels:
  // notional = SIZE * price / 1e6
  // At 10x: notional = 10 * capital → SIZE = 10 * capital * 1e6 / price
  // At 15x: notional = 15 * capital → SIZE = 15 * capital * 1e6 / price
  // At 25x: notional = 25 * capital → SIZE = 25 * capital * 1e6 / price

  const size15x = capital * 15n * 1_000_000n / basePrice;
  const size25x = capital * 25n * 1_000_000n / basePrice;

  console.log(`\n--- Test 1: Trade at ~15x leverage ---`);
  console.log(`  Size: ${size15x}`);
  console.log(`  Expected notional: ${fmt(size15x * basePrice / 1_000_000n)} SOL`);
  console.log(`  At 10% initial margin: need ${fmt(size15x * basePrice / 1_000_000n * 1000n / 10_000n)} SOL equity`);
  console.log(`  At 5% maint margin:   need ${fmt(size15x * basePrice / 1_000_000n * 500n / 10_000n)} SOL equity`);
  console.log(`  Actual equity:              ${fmt(capital)} SOL`);

  let trade15xOk = false;
  try {
    await trade(idx, size15x);
    trade15xOk = true;
    console.log(`  Result: ACCEPTED ← BUG! Should be rejected at initial_margin_bps=1000 (10x max)`);
  } catch (e: any) {
    console.log(`  Result: REJECTED (correct if initial_margin_bps were used)`);
  }

  // Close the position if it was opened
  if (trade15xOk) {
    try { await trade(idx, -size15x); } catch {}
    await delay(1000);
  }

  console.log(`\n--- Test 2: Trade at ~25x leverage ---`);
  console.log(`  Size: ${size25x}`);
  let trade25xOk = false;
  try {
    await trade(idx, size25x);
    trade25xOk = true;
    console.log(`  Result: ACCEPTED ← Double BUG (above even maintenance margin!)`);
  } catch {
    console.log(`  Result: REJECTED (correct — above even 5% maintenance margin)`);
  }

  if (trade25xOk) {
    try { await trade(idx, -size25x); } catch {}
  }

  // Clean up
  console.log(`\n--- Cleanup ---`);
  try {
    await delay(12_000);
    const s2 = await getState();
    const a2 = s2.accounts.find((a: any) => a.idx === idx);
    if (a2 && BigInt(a2.positionSize) === 0n) {
      try {
        const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
        const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);
        // Try withdraw + close
        try {
          const wKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
            payer.publicKey, SLAB, s2.config.vaultPubkey, userAta.address,
            vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
          ]);
          const wIx = buildIx({ programId: PROGRAM_ID, keys: wKeys, data: encodeWithdrawCollateral({ userIdx: idx, amount: BigInt(a2.capital).toString() }) });
          const wTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), wIx);
          await sendAndConfirmTransaction(conn, wTx, [payer], { commitment: "confirmed" });
        } catch {}
        await closeAccount(idx);
        console.log(`  Account ${idx} closed`);
      } catch (e: any) {
        console.log(`  Cleanup partial: ${e.message?.slice(0, 60)}`);
      }
    }
  } catch {}

  console.log(`\n============================================================`);
  console.log(`SUMMARY`);
  console.log(`============================================================`);
  console.log(`  15x leverage trade (10x should be max): ${trade15xOk ? "ACCEPTED — BUG CONFIRMED" : "REJECTED (no bug)"}`);
  console.log(`  25x leverage trade (above maint margin): ${trade25xOk ? "ACCEPTED — DOUBLE BUG" : "REJECTED (correct)"}`);
  if (trade15xOk && !trade25xOk) {
    console.log(`\n  FINDING L CONFIRMED: execute_trade() checks maintenance_margin_bps (5%)`);
    console.log(`  instead of initial_margin_bps (10%). Users can open at 20x leverage`);
    console.log(`  instead of the intended 10x maximum.`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
