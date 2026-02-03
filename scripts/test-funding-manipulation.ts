/**
 * Test: Funding Rate Manipulation (Finding M)
 *
 * The funding rate is computed at crank time from current LP net position,
 * then applied retroactively for the entire elapsed period since last funding.
 *
 * Attack scenario:
 * 1. Wait for stale crank (many slots since last funding accrual)
 * 2. Open large position to skew LP inventory
 * 3. Call crank - high funding rate computed and applied retroactively
 * 4. All existing positions pay/receive funding at the manipulated rate
 *
 * This test measures the funding impact under different timing scenarios.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeTradeCpi, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice, encodeCloseAccount, encodeWithdrawCollateral,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_WITHDRAW_COLLATERAL,
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

async function main() {
  console.log("============================================================");
  console.log("Funding Rate Manipulation Test (Finding M)");
  console.log("============================================================");

  let state = await getState();
  const basePrice = state.config.lastEffectivePriceE6;
  console.log(`  Price: ${basePrice}`);
  console.log(`  funding_horizon_slots: ${state.config.fundingHorizonSlots}`);
  console.log(`  funding_max_bps_per_slot: ${state.config.fundingMaxBpsPerSlot}`);
  console.log(`  last_funding_slot: ${state.engine.lastFundingSlot}`);
  console.log(`  funding_index_qpb_e6: ${state.engine.fundingIndexQpbE6}`);

  // Get current slot
  const slot = await conn.getSlot();
  const slotsSinceLastFunding = BigInt(slot) - state.engine.lastFundingSlot;
  console.log(`  Current slot: ${slot}`);
  console.log(`  Slots since last funding: ${slotsSinceLastFunding}`);

  // Check LP position
  const lp = state.accounts.find((a: any) => a.kind === "LP");
  console.log(`\n  LP position: ${lp?.positionSize || 0}`);
  console.log(`  LP capital: ${fmt(BigInt(lp?.capital || 0))}`);

  await pushPrice(basePrice);
  await crank();

  const DEPOSIT = 100_000_000n; // 0.1 SOL
  const SIZE = 10_000_000_000n; // 10B size

  // Create victim account (existing LONG position)
  console.log("\n--- Setup: Create victim with LONG position ---");
  const victimIdx = await initUser();
  if (victimIdx === null) { console.log("FATAL: account creation failed"); return; }
  await deposit(victimIdx, DEPOSIT);
  await trade(victimIdx, SIZE);

  state = await getState();
  let victim = state.accounts.find((a: any) => a.idx === victimIdx);
  const victimPnlBefore = BigInt(victim.pnl);
  const victimCapBefore = BigInt(victim.capital);
  console.log(`  Victim: pos=${victim.positionSize}, capital=${fmt(victimCapBefore)}, pnl=${fmt(victimPnlBefore)}`);

  // Record LP state
  const lpBefore = state.accounts.find((a: any) => a.kind === "LP");
  const lpPosBefore = BigInt(lpBefore.positionSize);
  console.log(`  LP after victim trade: pos=${lpPosBefore}`);

  // Wait some time to accumulate slots
  console.log("\n--- Wait 10s for slots to accumulate ---");
  await delay(10_000);

  // Crank to apply funding
  console.log("\n--- Crank to apply accumulated funding ---");
  const slotBefore = await conn.getSlot();
  await crank();
  const slotAfter = await conn.getSlot();
  console.log(`  Slot: ${slotBefore} → ${slotAfter}`);

  state = await getState();
  victim = state.accounts.find((a: any) => a.idx === victimIdx);
  const victimPnlAfter = BigInt(victim.pnl);
  const victimCapAfter = BigInt(victim.capital);
  const fundingDelta = victimPnlAfter - victimPnlBefore;
  console.log(`  Victim: pnl ${fmt(victimPnlBefore)} → ${fmt(victimPnlAfter)} (delta: ${fmt(fundingDelta)})`);
  console.log(`  Victim: capital ${fmt(victimCapBefore)} → ${fmt(victimCapAfter)}`);
  console.log(`  Funding index: ${state.engine.fundingIndexQpbE6}`);

  // Check if LP gained what victim lost (zero-sum)
  const lpAfter = state.accounts.find((a: any) => a.kind === "LP");
  const lpPnlDelta = BigInt(lpAfter.pnl) - BigInt(lpBefore.pnl);
  console.log(`  LP PnL delta: ${fmt(lpPnlDelta)}`);
  console.log(`  Zero-sum check: victim + LP = ${fmt(fundingDelta + lpPnlDelta)}`);

  // Cleanup
  console.log("\n--- Cleanup ---");
  try {
    await trade(victimIdx, -SIZE);
    await delay(12_000);
    state = await getState();
    victim = state.accounts.find((a: any) => a.idx === victimIdx);
    if (victim && BigInt(victim.positionSize) === 0n) {
      const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
      const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);
      try {
        const wKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
          payer.publicKey, SLAB, state.config.vaultPubkey, userAta.address,
          vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
        ]);
        const wIx = buildIx({ programId: PROGRAM_ID, keys: wKeys, data: encodeWithdrawCollateral({ userIdx: victimIdx, amount: BigInt(victim.capital).toString() }) });
        const wTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), wIx);
        await sendAndConfirmTransaction(conn, wTx, [payer], { commitment: "confirmed" });
      } catch {}
      const cKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
        payer.publicKey, SLAB, state.config.vaultPubkey, userAta.address,
        vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
      ]);
      const cIx = buildIx({ programId: PROGRAM_ID, keys: cKeys, data: encodeCloseAccount({ userIdx: victimIdx }) });
      const cTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), cIx);
      await sendAndConfirmTransaction(conn, cTx, [payer], { commitment: "confirmed" });
      console.log(`  Account ${victimIdx} closed`);
    }
  } catch {}

  console.log("\n============================================================");
  console.log("SUMMARY");
  console.log("============================================================");
  console.log(`  Funding applied over ~${slotAfter - slotBefore} slots`);
  console.log(`  Victim (LONG) funding delta: ${fmt(fundingDelta)}`);
  console.log(`  LP funding delta: ${fmt(lpPnlDelta)}`);
  if (fundingDelta < 0n) {
    console.log(`  LONG paid SHORT (LP was net short)`);
  } else if (fundingDelta > 0n) {
    console.log(`  SHORT paid LONG (LP was net long)`);
  } else {
    console.log(`  No funding accrued (balanced or rate = 0)`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
