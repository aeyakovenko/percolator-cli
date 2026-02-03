/**
 * Test: Fee Rounding to Zero (Related to Finding J)
 *
 * Trading fees are computed via floor division:
 *   notional = |exec_size| * exec_price / 1_000_000
 *   fee = notional * trading_fee_bps / 10_000
 *
 * With trading_fee_bps = 10 (0.10%), any trade where notional < 1000 will have fee = 0.
 * And notional rounds to zero when |exec_size| * exec_price < 1_000_000.
 *
 * This script tests whether micro-trades can be executed with zero trading fees.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
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

const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(9);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const { parseParams } = await import("../src/solana/slab.js");
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
  console.log("Fee Rounding Test");
  console.log("============================================================");

  const state = await getState();
  const basePrice = state.config.lastEffectivePriceE6;
  const feeBps = state.params.tradingFeeBps;
  console.log(`  Price: ${basePrice}`);
  console.log(`  trading_fee_bps: ${feeBps}`);

  await pushPrice(basePrice);
  await crank();

  // Calculate the threshold where fee rounds to zero
  // notional = |size| * price / 1e6
  // fee = notional * fee_bps / 10000
  // fee = 0 when notional < 10000 / fee_bps
  // For fee_bps = 10: notional < 1000
  // notional < 1000 when |size| * price < 1e6 * 1000 = 1e9
  // |size| < 1e9 / price
  const zeroFeeThreshold = 1_000_000_000n / basePrice;
  console.log(`  Zero-fee size threshold: ${zeroFeeThreshold} (|size| * price < 1e9)`);

  const DEPOSIT = 50_000_000n; // 0.05 SOL

  const idx = await initUser();
  if (idx === null) { console.log("FATAL: account creation failed"); return; }
  await deposit(idx, DEPOSIT);

  let s = await getState();
  let acc = s.accounts.find((a: any) => a.idx === idx);
  const insBefore = BigInt(s.engine.insuranceFund.balance);
  const capBefore = BigInt(acc.capital);
  console.log(`\n  Initial: capital=${fmt(capBefore)}, insurance=${fmt(insBefore)}`);

  // Test 1: Normal-sized trade (should have fee)
  console.log("\n--- Test 1: Normal trade (5B size) ---");
  const normalSize = 5_000_000_000n;
  const normalNotional = normalSize * basePrice / 1_000_000n;
  const normalExpectedFee = normalNotional * feeBps / 10_000n;
  console.log(`  Size: ${normalSize}, notional: ${fmt(normalNotional)}, expected fee: ${fmt(normalExpectedFee)}`);

  await trade(idx, normalSize);
  s = await getState();
  acc = s.accounts.find((a: any) => a.idx === idx);
  const insAfterNormal = BigInt(s.engine.insuranceFund.balance);
  const insDelta1 = insAfterNormal - insBefore;
  console.log(`  Insurance delta: ${fmt(insDelta1)} (expected ~${fmt(normalExpectedFee)})`);

  // Close position
  await trade(idx, -normalSize);

  // Test 2: Micro trade (might have zero fee)
  console.log("\n--- Test 2: Micro trade (below threshold) ---");
  const microSize = zeroFeeThreshold / 2n; // Half the threshold
  const microNotional = microSize * basePrice / 1_000_000n;
  const microExpectedFee = microNotional * feeBps / 10_000n;
  console.log(`  Size: ${microSize}, notional: ${fmt(microNotional)}, expected fee: ${fmt(microExpectedFee)}`);

  s = await getState();
  const insBeforeMicro = BigInt(s.engine.insuranceFund.balance);

  try {
    await trade(idx, microSize);
    s = await getState();
    acc = s.accounts.find((a: any) => a.idx === idx);
    const insAfterMicro = BigInt(s.engine.insuranceFund.balance);
    const insDelta2 = insAfterMicro - insBeforeMicro;
    console.log(`  Insurance delta: ${fmt(insDelta2)}`);

    if (insDelta2 === 0n) {
      console.log(`  RESULT: Zero-fee trade EXECUTED`);
    } else {
      console.log(`  RESULT: Fee was charged (${fmt(insDelta2)})`);
    }

    // Close micro position
    await trade(idx, -microSize);
  } catch (e: any) {
    console.log(`  RESULT: Trade rejected (${e.message?.slice(0, 60)})`);
  }

  // Test 3: Multiple micro trades
  console.log("\n--- Test 3: Multiple micro trades (10x) ---");
  s = await getState();
  const insBeforeMulti = BigInt(s.engine.insuranceFund.balance);
  let successCount = 0;

  for (let i = 0; i < 10; i++) {
    try {
      await trade(idx, microSize);
      await trade(idx, -microSize);
      successCount++;
    } catch {
      break;
    }
  }

  s = await getState();
  const insAfterMulti = BigInt(s.engine.insuranceFund.balance);
  const totalInsDelta = insAfterMulti - insBeforeMulti;
  console.log(`  Completed: ${successCount}/10 round trips`);
  console.log(`  Total insurance delta: ${fmt(totalInsDelta)}`);
  console.log(`  Average fee per round trip: ${successCount > 0 ? fmt(totalInsDelta / BigInt(successCount)) : 'N/A'}`);

  // Cleanup
  console.log("\n--- Cleanup ---");
  try {
    await delay(12_000);
    s = await getState();
    acc = s.accounts.find((a: any) => a.idx === idx);
    if (acc && BigInt(acc.positionSize) === 0n) {
      const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
      const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);
      try {
        const wKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
          payer.publicKey, SLAB, s.config.vaultPubkey, userAta.address,
          vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
        ]);
        const wIx = buildIx({ programId: PROGRAM_ID, keys: wKeys, data: encodeWithdrawCollateral({ userIdx: idx, amount: BigInt(acc.capital).toString() }) });
        const wTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), wIx);
        await sendAndConfirmTransaction(conn, wTx, [payer], { commitment: "confirmed" });
      } catch {}
      const cKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
        payer.publicKey, SLAB, s.config.vaultPubkey, userAta.address,
        vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
      ]);
      const cIx = buildIx({ programId: PROGRAM_ID, keys: cKeys, data: encodeCloseAccount({ userIdx: idx }) });
      const cTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), cIx);
      await sendAndConfirmTransaction(conn, cTx, [payer], { commitment: "confirmed" });
      console.log(`  Account ${idx} closed`);
    }
  } catch {}

  console.log("\n============================================================");
  console.log("SUMMARY");
  console.log("============================================================");
  console.log(`  Zero-fee threshold: size < ${zeroFeeThreshold}`);
  console.log(`  Normal trade fee: ${fmt(insDelta1)}`);
  console.log(`  Micro trade total fee (${successCount} round trips): ${fmt(totalInsDelta)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
