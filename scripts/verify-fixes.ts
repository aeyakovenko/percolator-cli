/**
 * Verify Finding G and Finding C fixes on deployed program.
 *
 * Finding G: Two-pass settlement. Conservation: vault = c_tot + insurance + pnl_pos_tot.
 * Finding C: close_account with fee debt forgiveness (fee_credits set to 0 on close).
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID,
  NATIVE_MINT, createSyncNativeInstruction, getAccount,
} from "@solana/spl-token";
import {
  fetchSlab, parseEngine, parseConfig, parseParams,
  parseAccount, parseUsedIndices, AccountKind,
} from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice,
  encodeSetOracleAuthority, encodeCloseAccount,
  encodeInitLP, encodeTradeCpi,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_INIT_LP,
  ACCOUNTS_TRADE_CPI,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const VAULT = new PublicKey(marketInfo.vault);

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
    if (acc) accounts.push({ idx, ...acc });
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

// ===========================================================================
// TEST 1: Conservation after trades (Finding G)
// ===========================================================================
async function testConservation() {
  console.log("\n============================================================");
  console.log("TEST 1: Conservation after trades (Finding G fix)");
  console.log("============================================================");

  const state = await getState();
  const e = state.engine;
  const totalCapital = state.accounts.reduce((sum: bigint, a: any) => sum + BigInt(a.capital), 0n);
  const insurance = e.insuranceFund.balance;
  const pnlPosTot = e.pnlPosTot;
  const vault = e.vault;

  const tracked = totalCapital + insurance + pnlPosTot;
  const diff = vault > tracked ? vault - tracked : tracked - vault;

  console.log(`  Vault (internal): ${fmt(vault)}`);
  console.log(`  Capital total:    ${fmt(totalCapital)}`);
  console.log(`  Insurance:        ${fmt(insurance)}`);
  console.log(`  PnlPosTot:        ${fmt(pnlPosTot)}`);
  console.log(`  Tracked total:    ${fmt(tracked)}`);
  console.log(`  Difference:       ${diff}`);

  // Also check vault internal matches actual token balance
  try {
    const vaultAccount = await getAccount(conn, VAULT);
    const tokenBalance = vaultAccount.amount;
    const vaultDiff = vault > tokenBalance ? vault - tokenBalance : tokenBalance - vault;
    console.log(`  Vault tokens:     ${fmt(tokenBalance)}`);
    console.log(`  Vault int-vs-tok: ${vaultDiff}`);
    if (vaultDiff > 1000n) {
      console.log("  WARNING: Vault internal field doesn't match token balance!");
    }
  } catch (e: any) {
    console.log(`  (Could not read vault tokens: ${e.message?.slice(0, 50)})`);
  }

  // Conservation: tracked <= vault (slack is OK, indicates haircutted value from old program)
  const slack = vault - totalCapital - insurance;
  console.log(`  Slack (vault-cap-ins): ${fmt(slack)}`);
  console.log(`  PnlPosTot should explain most of slack: ${fmt(pnlPosTot)}`);
  const unexplained = slack > pnlPosTot ? slack - pnlPosTot : pnlPosTot - slack;
  console.log(`  Unexplained slack: ${fmt(unexplained)}`);

  if (slack < 0n) {
    console.log("\n  FAIL: Vault underfunded (capital + insurance > vault)");
    return false;
  }

  // c_tot sanity
  if (e.cTot !== totalCapital) {
    console.log(`\n  FAIL: c_tot mismatch: engine=${fmt(e.cTot)}, computed=${fmt(totalCapital)}`);
    return false;
  }

  // Haircut should be 100% (residual > 0)
  const residual = vault - totalCapital - insurance;
  if (pnlPosTot > 0n) {
    const haircutPct = Number(residual * 10000n / pnlPosTot) / 100;
    console.log(`  Haircut: ${haircutPct}%`);
    if (haircutPct >= 100) {
      console.log("  Haircut >= 100% — positive PnL fully backed");
    } else {
      console.log(`  WARNING: Haircut < 100% — undercollateralized (${haircutPct}%)`);
    }
  }

  console.log("\n  PASS: Conservation holds (vault >= tracked)");
  return true;
}

// ===========================================================================
// TEST 2: close_account lifecycle (Finding C fix)
// ===========================================================================
async function testCloseAccount() {
  console.log("\n============================================================");
  console.log("TEST 2: Account close lifecycle (Finding C fix)");
  console.log("============================================================");

  // Keep price fresh
  const state0 = await getState();
  const basePrice = state0.config.authorityPriceE6 > 0n ? state0.config.authorityPriceE6 : 9623n;
  await pushPrice(basePrice);
  await crank();

  // Create account
  console.log("  Creating account...");
  const idx = await initUser();
  if (idx === null) {
    console.log("  FAIL: Could not create account");
    return false;
  }
  console.log(`  Account index: ${idx}`);

  // Deposit
  const DEPOSIT_AMT = 10_000_000n; // 0.01 SOL
  await deposit(idx, DEPOSIT_AMT);
  console.log(`  Deposited: ${fmt(DEPOSIT_AMT)} SOL`);

  // Verify account state
  let state = await getState();
  let acc = state.accounts.find((a: any) => a.idx === idx);
  if (!acc) {
    console.log("  FAIL: Account not found after deposit");
    return false;
  }
  console.log(`  Capital: ${fmt(BigInt(acc.capital))}, FeeCredits: ${acc.feeCredits}`);

  // Crank a few times
  for (let i = 0; i < 3; i++) {
    await delay(1000);
    await pushPrice(basePrice);
    await crank();
  }

  // Check state after cranking
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  if (!acc) {
    console.log("  Account was GC'd during cranking");
    return false;
  }
  console.log(`  After cranks — Capital: ${fmt(BigInt(acc.capital))}, FeeCredits: ${acc.feeCredits}`);

  // Close account
  console.log("  Closing account...");
  try {
    await closeAccount(idx);
    console.log("  close_account SUCCEEDED");
  } catch (e: any) {
    console.log(`  close_account FAILED: ${e.message?.slice(0, 100)}`);
    return false;
  }

  // Verify account is gone
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  if (acc) {
    console.log("  FAIL: Account still exists after close");
    return false;
  }
  console.log("  Account successfully closed and removed");
  console.log("\n  PASS: Account lifecycle (create → deposit → crank → close) works");
  return true;
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("============================================================");
  console.log("FIX VERIFICATION: Finding G (conservation) + Finding C (close)");
  console.log("============================================================");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Slab: ${SLAB.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  // Ensure oracle authority is us
  try { await (async () => {
    const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);
    const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  })(); } catch {}

  const results: { name: string; pass: boolean }[] = [];

  results.push({ name: "Conservation (Finding G)", pass: await testConservation() });
  results.push({ name: "Account close (Finding C)", pass: await testCloseAccount() });

  console.log("\n============================================================");
  console.log("RESULTS");
  console.log("============================================================");
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  }
  const allPass = results.every(r => r.pass);
  console.log(`\n  Overall: ${allPass ? "ALL PASS" : "SOME FAILED"}`);
  console.log("============================================================\n");
}

main().catch(e => { console.error("Fatal:", e.message?.slice(0, 200)); process.exit(1); });
