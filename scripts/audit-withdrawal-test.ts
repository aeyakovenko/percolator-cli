/**
 * Security Audit: Withdrawal Investigation
 *
 * Investigate why withdrawals are failing and test various amounts
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseParams, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
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

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    header: parseHeader(data),
    config: parseConfig(data),
    engine: parseEngine(data),
    params: parseParams(data),
    data,
    vaultBalance: vaultInfo ? vaultInfo.lamports / 1e9 : 0,
  };
}

async function pushPrice(priceUsd: number): Promise<boolean> {
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
  } catch (e: any) {
    console.log(`  PushPrice failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

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

async function withdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error?: string; logs?: string[] }> {
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
    // First simulate to get logs
    const sim = await conn.simulateTransaction(tx, [payer]);
    if (sim.value.err) {
      return { success: false, error: JSON.stringify(sim.value.err), logs: sim.value.logs || [] };
    }

    // Then send
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message?.slice(0, 200) };
  }
}

async function findMyAccounts(): Promise<{users: number[], lps: number[]}> {
  const { data } = await getState();
  const indices = parseUsedIndices(data);
  const users: number[] = [];
  const lps: number[] = [];

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;
    if (acc.owner.equals(payer.publicKey)) {
      if (acc.kind === AccountKind.LP) {
        lps.push(idx);
      } else {
        users.push(idx);
      }
    }
  }
  return { users, lps };
}

async function main() {
  console.log("=== WITHDRAWAL INVESTIGATION ===\n");

  const { users } = await findMyAccounts();
  if (users.length === 0) {
    console.log("ERROR: No user accounts found");
    return;
  }

  const userIdx = users[0];
  console.log(`User account: ${userIdx}`);

  // Get current state
  const { data, engine, config, vaultBalance } = await getState();
  const acc = parseAccount(data, userIdx);
  if (!acc) {
    console.log("ERROR: Account not found");
    return;
  }

  const capital = Number(acc.capital);
  const capitalSol = capital / 1e9;
  const pnl = Number(acc.pnl) / 1e9;
  const posSize = acc.positionSize;

  console.log(`\n=== ACCOUNT STATE ===`);
  console.log(`Capital: ${capitalSol.toFixed(9)} SOL (${capital} lamports)`);
  console.log(`PnL: ${pnl.toFixed(9)} SOL`);
  console.log(`Position Size: ${posSize.toString()}`);
  console.log(`Position open: ${posSize !== 0n}`);
  console.log(`\nVault balance: ${vaultBalance.toFixed(9)} SOL`);
  console.log(`Insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);
  console.log(`Oracle price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)}`);
  console.log(`Crank step: ${engine.crankStep}`);
  console.log(`Last crank slot: ${engine.lastCrankSlot.toString()}`);

  // Run crank to ensure fresh state
  console.log("\n=== RUNNING CRANK ===");
  await crank();

  // Test various withdrawal amounts
  console.log("\n=== WITHDRAWAL TESTS ===");

  const testAmounts = [
    { label: "1 lamport", amount: 1n },
    { label: "1000 lamports", amount: 1000n },
    { label: "0.001 SOL", amount: 1_000_000n },
    { label: "0.01 SOL", amount: 10_000_000n },
    { label: "0.1 SOL", amount: 100_000_000n },
    { label: "0.5 SOL", amount: 500_000_000n },
    { label: "1.0 SOL", amount: 1_000_000_000n },
    { label: "Full capital", amount: BigInt(capital) },
    { label: "Capital + 0.1 SOL", amount: BigInt(capital) + 100_000_000n },
    { label: "10x capital", amount: BigInt(capital) * 10n },
  ];

  for (const test of testAmounts) {
    console.log(`\nTesting: ${test.label} (${test.amount} lamports = ${Number(test.amount) / 1e9} SOL)`);
    const result = await withdraw(userIdx, test.amount);

    if (result.success) {
      console.log(`  SUCCESS!`);
      // Refresh state after successful withdrawal
      const { data: newData, vaultBalance: newVault } = await getState();
      const newAcc = parseAccount(newData, userIdx);
      const newCapital = newAcc ? Number(newAcc.capital) / 1e9 : 0;
      console.log(`  New capital: ${newCapital.toFixed(9)} SOL`);
      console.log(`  New vault: ${newVault.toFixed(9)} SOL`);
    } else {
      console.log(`  FAILED: ${result.error}`);
      if (result.logs && result.logs.length > 0) {
        console.log(`  Logs:`);
        result.logs.slice(-5).forEach(log => console.log(`    ${log}`));
      }
    }
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  const { data: finalData, vaultBalance: finalVault, engine: finalEngine } = await getState();
  const finalAcc = parseAccount(finalData, userIdx);
  const finalCapital = finalAcc ? Number(finalAcc.capital) / 1e9 : 0;

  console.log(`Capital: ${finalCapital.toFixed(9)} SOL`);
  console.log(`Vault: ${finalVault.toFixed(9)} SOL`);
  console.log(`Insurance: ${(Number(finalEngine.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);
}

main().catch(console.error);
