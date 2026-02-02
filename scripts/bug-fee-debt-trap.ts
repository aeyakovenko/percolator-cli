/**
 * Bug Reproduction: Fee Debt Traps Accounts (Finding C)
 *
 * close_account blocks when fee_credits < 0. Maintenance fees accrue on idle
 * accounts. A small-capital account with exhausted fee_credits gets trapped:
 * - Cannot close (fee_credits negative)
 * - Capital drained by fee settlement each crank
 * - Eventually GC frees the slot (doesn't check fee_credits), user loses capital
 *
 * Steps:
 * 1. Create account, deposit small capital (0.01 SOL)
 * 2. Wait for fee_credits to drain (or crank repeatedly)
 * 3. Attempt close_account — expect failure (InsufficientBalance)
 * 4. Observe capital draining via crank fee settlement
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice, encodeSetOracleAuthority,
  encodeCloseAccount,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_ACCOUNT,
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
const VAULT = new PublicKey(marketInfo.vault);

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
async function getState() {
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
    });
  }
  return { engine, config, params, accounts, data };
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

// ===========================================================================
// BUG REPRODUCTION
// ===========================================================================
async function reproduceFeeDebtTrap() {
  console.log("\n============================================================");
  console.log("BUG REPRODUCTION: Fee Debt Traps Accounts (Finding C)");
  console.log("============================================================");
  console.log("  close_account blocks when fee_credits < 0.");
  console.log("  Maintenance fees accrue, draining capital with no exit.");
  console.log("============================================================");

  await ensureSolBalance(5_000_000_000n);

  // Ensure oracle authority
  try { await setOracleAuthority(); } catch {}
  const state0 = await getState();
  const basePrice = state0.config.authorityPriceE6 > 0n ? state0.config.authorityPriceE6 : 9623n;
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Step 1: Create account with small capital
  // ------------------------------------------------------------------
  console.log("\n=== Step 1: Create account with small deposit ===");
  const idx = await initUser();
  if (idx === null) {
    console.log("  FAILED to create account");
    process.exit(1);
  }
  console.log(`  Created account index: ${idx}`);

  // Deposit small amount — 0.01 SOL (10M lamports)
  const SMALL_DEPOSIT = 10_000_000n;
  await deposit(idx, SMALL_DEPOSIT);
  console.log(`  Deposited: ${fmt(SMALL_DEPOSIT)} SOL`);

  let state = await getState();
  const acc0 = state.accounts.find((a: any) => a.idx === idx);
  console.log(`  Initial capital: ${fmt(BigInt(acc0?.capital ?? 0))} SOL`);
  console.log(`  Initial feeCredits: ${acc0?.feeCredits ?? "N/A"}`);

  // ------------------------------------------------------------------
  // Step 2: Crank repeatedly to accrue maintenance fees
  // ------------------------------------------------------------------
  console.log("\n=== Step 2: Crank to accrue fees ===");
  const MAX_CRANKS = 20;
  for (let i = 0; i < MAX_CRANKS; i++) {
    try {
      await pushPrice(basePrice); // keep price fresh
      await crank();
    } catch (e: any) {
      console.log(`  Crank ${i + 1} error: ${e.message?.slice(0, 60)}`);
    }
    await delay(2000); // wait for slots to pass to accrue time-based fees

    state = await getState();
    const acc = state.accounts.find((a: any) => a.idx === idx);
    if (!acc) {
      console.log(`  Account ${idx} was garbage collected at crank ${i + 1}!`);
      console.log("  Capital was consumed by fees before user could close.");
      console.log("\n  *** BUG CONFIRMED: Account GC'd with no user exit path ***");
      break;
    }
    const cap = BigInt(acc.capital);
    const fc = acc.feeCredits;
    console.log(`  Crank ${i + 1}: capital=${fmt(cap)}, feeCredits=${fc}`);

    // Check if fee_credits is negative
    if (fc !== undefined && BigInt(fc) < 0n) {
      console.log(`\n  fee_credits went negative at crank ${i + 1}`);

      // ------------------------------------------------------------------
      // Step 3: Attempt close_account — expect failure
      // ------------------------------------------------------------------
      console.log("\n=== Step 3: Attempt close_account (should fail) ===");
      try {
        await closeAccount(idx);
        console.log("  close_account SUCCEEDED — bug not reproduced (fee_credits recovered?)");
      } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("InsufficientBalance") || msg.includes("0x1") || msg.includes("custom program error")) {
          console.log(`  close_account FAILED as expected: ${msg.slice(0, 80)}`);
          console.log("\n  *** BUG CONFIRMED ***");
          console.log("  Account has capital but cannot close due to negative fee_credits.");
          console.log(`  Remaining capital: ${fmt(cap)} SOL (trapped)`);
        } else {
          console.log(`  close_account failed with unexpected error: ${msg.slice(0, 80)}`);
        }
      }

      // ------------------------------------------------------------------
      // Step 4: Show capital drain over subsequent cranks
      // ------------------------------------------------------------------
      console.log("\n=== Step 4: Watch capital drain ===");
      for (let j = 0; j < 5; j++) {
        await delay(2000);
        try {
          await pushPrice(basePrice);
          await crank();
        } catch {}
        state = await getState();
        const accNow = state.accounts.find((a: any) => a.idx === idx);
        if (!accNow) {
          console.log(`  Account GC'd after ${j + 1} more cranks — capital fully consumed`);
          break;
        }
        console.log(`  Drain ${j + 1}: capital=${fmt(BigInt(accNow.capital))}, feeCredits=${accNow.feeCredits}`);
      }
      break;
    }
  }

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------
  console.log("\n============================================================");
  console.log("REPORT: Fee Debt Trap");
  console.log("============================================================");
  console.log("  Root cause: close_account requires fee_credits >= 0");
  console.log("  Maintenance fees can drain fee_credits below 0 on idle accounts");
  console.log("  User cannot close account to withdraw remaining capital");
  console.log("  Capital is consumed by fee settlement until GC frees the slot");
  console.log("============================================================\n");
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("============================================================");
  console.log("FEE DEBT TRAP BUG REPRODUCTION");
  console.log("============================================================");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Slab: ${SLAB.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  await reproduceFeeDebtTrap();
}

main().catch(e => { console.error("Fatal:", e.message?.slice(0, 200)); process.exit(1); });
