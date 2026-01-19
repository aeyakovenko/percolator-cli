/**
 * Security Audit: Crank and then test withdrawals
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function crank(): Promise<boolean> {
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
  } catch (e: any) {
    console.log(`  Crank failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

async function simulateWithdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error?: string; logs?: string[] }> {
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
    const sim = await conn.simulateTransaction(tx, [payer]);
    if (sim.value.err) {
      return { success: false, error: JSON.stringify(sim.value.err), logs: sim.value.logs || [] };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function main() {
  console.log("=== CRANK AND WITHDRAW TEST ===\n");

  // Check current slot and last crank
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const slot = await conn.getSlot();

  console.log("Before crank:");
  console.log(`  Current slot: ${slot}`);
  console.log(`  Last crank slot: ${engine.lastCrankSlot.toString()}`);
  console.log(`  Slots since crank: ${BigInt(slot) - engine.lastCrankSlot}`);
  console.log(`  Crank step: ${engine.crankStep}`);
  console.log(`  Last sweep start: ${engine.lastSweepStartSlot.toString()}`);
  console.log(`  Last sweep complete: ${engine.lastSweepCompleteSlot.toString()}`);

  // Test withdrawal before crank
  console.log("\nTesting withdrawal BEFORE crank:");
  const result1 = await simulateWithdraw(1, 1000000n); // 0.001 SOL
  console.log(`  0.001 SOL: ${result1.success ? "SUCCESS" : "FAILED"}`);
  if (!result1.success && result1.logs) {
    const errorLine = result1.logs.find(l => l.includes("error") || l.includes("failed"));
    if (errorLine) console.log(`  Error: ${errorLine.slice(0, 80)}`);
  }

  // Run multiple cranks to complete sweep cycle (16 steps)
  console.log("\nRunning cranks (16 steps to complete sweep)...");
  for (let i = 0; i < 16; i++) {
    const success = await crank();
    if (!success) break;
    process.stdout.write(`  Step ${i + 1} done\r`);
  }
  console.log("\n");

  // Check state after crank
  const data2 = await fetchSlab(conn, SLAB);
  const engine2 = parseEngine(data2);
  const slot2 = await conn.getSlot();

  console.log("After crank:");
  console.log(`  Current slot: ${slot2}`);
  console.log(`  Last crank slot: ${engine2.lastCrankSlot.toString()}`);
  console.log(`  Slots since crank: ${BigInt(slot2) - engine2.lastCrankSlot}`);
  console.log(`  Crank step: ${engine2.crankStep}`);
  console.log(`  Last sweep start: ${engine2.lastSweepStartSlot.toString()}`);
  console.log(`  Last sweep complete: ${engine2.lastSweepCompleteSlot.toString()}`);

  // Test withdrawal after crank
  console.log("\nTesting withdrawal AFTER crank:");
  const result2 = await simulateWithdraw(1, 1000000n); // 0.001 SOL
  console.log(`  0.001 SOL: ${result2.success ? "SUCCESS" : "FAILED"}`);
  if (!result2.success && result2.logs) {
    const errorLine = result2.logs.find(l => l.includes("error") || l.includes("failed"));
    if (errorLine) console.log(`  Error: ${errorLine.slice(0, 80)}`);
  }

  // Test different amounts
  console.log("\nTesting various amounts after crank:");
  const amounts = [1n, 1000n, 1000000n, 10000000n, 100000000n, 500000000n];
  for (const amt of amounts) {
    const result = await simulateWithdraw(1, amt);
    console.log(`  ${(Number(amt) / 1e9).toFixed(9)} SOL: ${result.success ? "SUCCESS" : "FAILED"}`);
  }

  // Check my accounts
  console.log("\n=== ACCOUNTS AFTER CRANK ===");
  const indices = parseUsedIndices(data2);
  for (const idx of indices) {
    const acc = parseAccount(data2, idx);
    if (!acc || !acc.owner.equals(payer.publicKey)) continue;
    const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
    console.log(`\nAccount ${idx} (${kind}):`);
    console.log(`  Capital: ${(Number(acc.capital) / 1e9).toFixed(9)} SOL`);
    console.log(`  PnL: ${(Number(acc.pnl) / 1e9).toFixed(9)} SOL`);
    console.log(`  Position: ${acc.positionSize.toString()}`);
  }
}

main().catch(console.error);
