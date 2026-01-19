/**
 * Security Audit: Aggressive Attack Vectors
 *
 * More extreme attacks to find edge cases.
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    config: parseConfig(data),
    engine: parseEngine(data),
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
    log(`PushPrice ${priceUsd} failed: ${e.message?.slice(0, 50)}`);
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
  } catch { return false; }
}

async function trade(userIdx: number, lpIdx: number, size: bigint): Promise<boolean> {
  const tradeData = encodeTradeCpi({ userIdx, lpIdx, size });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, MATCHER_CTX, LP_PDA,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function withdraw(userIdx: number, amount: bigint): Promise<boolean> {
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
  log("=== AGGRESSIVE ATTACK TESTS ===\n");

  const { vaultBalance: initialVault, engine: initialEngine } = await getState();
  const initialInsurance = Number(initialEngine.insuranceFund.balance) / 1e9;

  log(`Initial vault: ${initialVault.toFixed(9)} SOL`);
  log(`Initial insurance: ${initialInsurance.toFixed(9)} SOL`);

  // Find user account
  const { data } = await getState();
  const indices = parseUsedIndices(data);
  let userIdx = -1;
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.User && acc.owner.equals(payer.publicKey)) {
      userIdx = idx;
      break;
    }
  }

  if (userIdx < 0) {
    log("No user account found!");
    return;
  }

  log(`Using account ${userIdx}`);

  // Fresh cranks
  log("\nRunning initial cranks...");
  for (let i = 0; i < 16; i++) await crank();

  // ATTACK 1: Negative price attempt
  log("\n=== ATTACK 1: NEGATIVE PRICE ===");
  let negResult = false;
  try {
    negResult = await pushPrice(-100);
  } catch (e: any) {
    log(`Negative price rejected at SDK level: ${e.message?.slice(0, 50)}`);
  }
  log(`Negative price: ${negResult ? "ACCEPTED (VULNERABILITY!)" : "REJECTED (correct)"}`);

  // ATTACK 2: Extremely small price (near zero)
  log("\n=== ATTACK 2: NEAR-ZERO PRICE ===");
  const tinyPrices = [0.001, 0.0001, 0.00001];
  for (const p of tinyPrices) {
    const result = await pushPrice(p);
    log(`Price $${p}: ${result ? "ACCEPTED" : "REJECTED"}`);
    if (result) {
      await crank();
      // Try to exploit
      await trade(userIdx, 0, 1000000n);
      await crank();
    }
  }

  // ATTACK 3: Extremely large price
  log("\n=== ATTACK 3: EXTREME PRICE ===");
  const hugePrices = [1000000, 10000000, 100000000];
  for (const p of hugePrices) {
    const result = await pushPrice(p);
    log(`Price $${p}: ${result ? "ACCEPTED" : "REJECTED"}`);
    if (result) {
      await crank();
    }
  }

  // ATTACK 4: Rapid price flipping
  log("\n=== ATTACK 4: RAPID PRICE FLIPPING ===");
  await pushPrice(150);
  await crank();

  // Open position
  await trade(userIdx, 0, 2000000n);

  for (let i = 0; i < 10; i++) {
    const price = i % 2 === 0 ? 10 : 500;
    await pushPrice(price);
    // Don't crank - see if we can exploit stale state
  }

  // Try withdrawal without crank
  log("Attempting withdrawal without crank...");
  const withdrawResult = await withdraw(userIdx, 100000000n);
  log(`Withdrawal without crank: ${withdrawResult ? "SUCCESS (vulnerability?)" : "BLOCKED (correct)"}`);

  // Now crank and close
  for (let i = 0; i < 16; i++) await crank();

  const { data: data2 } = await getState();
  const acc = parseAccount(data2, userIdx);
  if (acc && acc.positionSize !== 0n) {
    await trade(userIdx, 0, -acc.positionSize);
  }

  // ATTACK 5: Integer overflow attempt
  log("\n=== ATTACK 5: INTEGER OVERFLOW ===");
  const maxI128 = (1n << 127n) - 1n;
  log(`Attempting max i128 position: ${maxI128.toString().slice(0, 20)}...`);
  const overflowResult = await trade(userIdx, 0, maxI128);
  log(`Max position: ${overflowResult ? "ACCEPTED (vulnerability!)" : "REJECTED (correct)"}`);

  // ATTACK 6: Timestamp manipulation (future)
  log("\n=== ATTACK 6: FUTURE TIMESTAMP ===");
  const futureTs = BigInt(Math.floor(Date.now() / 1000) + 86400 * 365); // 1 year future
  const priceE6 = BigInt(150_000_000);
  const pushData = encodePushOraclePrice({ priceE6, timestamp: futureTs });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const futureTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData })
  );
  try {
    await sendAndConfirmTransaction(conn, futureTx, [payer], { commitment: "confirmed" });
    log("Future timestamp: ACCEPTED (check if exploitable)");
  } catch {
    log("Future timestamp: REJECTED (correct)");
  }

  // ATTACK 7: Concurrent operations
  log("\n=== ATTACK 7: RACE CONDITIONS ===");
  await pushPrice(150);
  await crank();

  // Try to send multiple trades simultaneously
  const tradePromises = [];
  for (let i = 0; i < 5; i++) {
    tradePromises.push(trade(userIdx, 0, 100000n));
  }
  const results = await Promise.allSettled(tradePromises);
  const successes = results.filter(r => r.status === "fulfilled" && r.value).length;
  log(`Concurrent trades: ${successes}/5 succeeded`);

  // Clean up
  await crank();
  const { data: data3 } = await getState();
  const acc3 = parseAccount(data3, userIdx);
  if (acc3 && acc3.positionSize !== 0n) {
    await trade(userIdx, 0, -acc3.positionSize);
  }

  // Restore price
  await pushPrice(150);
  for (let i = 0; i < 16; i++) await crank();

  // Final state
  const { vaultBalance: finalVault, engine: finalEngine } = await getState();
  const finalInsurance = Number(finalEngine.insuranceFund.balance) / 1e9;

  log("\n=== FINAL RESULTS ===");
  log(`Vault: ${initialVault.toFixed(9)} -> ${finalVault.toFixed(9)} (Δ ${(finalVault - initialVault).toFixed(6)})`);
  log(`Insurance: ${initialInsurance.toFixed(9)} -> ${finalInsurance.toFixed(9)} (Δ ${(finalInsurance - initialInsurance).toFixed(6)})`);
  log(`Lifetime liquidations: ${finalEngine.lifetimeLiquidations.toString()}`);

  // Summary
  log("\n=== ATTACK SUMMARY ===");
  log("Negative price: " + (negResult ? "VULNERABLE" : "PROTECTED"));
  log("Integer overflow: " + (overflowResult ? "VULNERABLE" : "PROTECTED"));
  log("Stale state withdrawal: " + (withdrawResult ? "VULNERABLE" : "PROTECTED"));
}

main().catch(console.error);
