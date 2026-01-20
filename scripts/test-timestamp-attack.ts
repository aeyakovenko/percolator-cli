/**
 * Oracle Timestamp Manipulation Attack
 *
 * Test if manipulating the timestamp in price updates can cause issues:
 * 1. Old timestamps (replay attack)
 * 2. Future timestamps (advance time)
 * 3. Zero timestamp
 * 4. Max timestamp
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseConfig } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const DELAY_MS = 2000;

async function delay(ms: number = DELAY_MS) {
  await new Promise(r => setTimeout(r, ms));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getState() {
  await delay(500);
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    engine: parseEngine(data),
    config: parseConfig(data),
    data,
    vaultBalance: vaultInfo ? vaultInfo.lamports / 1e9 : 0,
  };
}

async function pushPriceWithTimestamp(priceUsd: number, timestamp: bigint): Promise<{ success: boolean; error?: string }> {
  await delay();
  const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
  const data = encodePushOraclePrice({ priceE6, timestamp });
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message?.slice(0, 100) };
  }
}

async function crank(): Promise<boolean> {
  await delay();
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

async function main() {
  log("=== ORACLE TIMESTAMP MANIPULATION ATTACK ===\n");

  // Initial state
  const { vaultBalance: v1, config: c1 } = await getState();

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Current Authority Price: $${(Number(c1.authorityPriceE6) / 1e6).toFixed(2)}`);
  log(`  Authority Timestamp: ${c1.authorityTimestamp.toString()}`);

  const currentUnix = Math.floor(Date.now() / 1000);
  log(`\nCurrent Unix Time: ${currentUnix}`);

  // ===== TEST 1: Very Old Timestamp (Replay Attack) =====
  log("\n=== TEST 1: Old Timestamp (Replay Attack) ===");

  const oldTimestamp = BigInt(currentUnix - 86400 * 365); // 1 year ago
  log(`Attempting price push with timestamp from 1 year ago...`);

  const r1 = await pushPriceWithTimestamp(500, oldTimestamp);
  log(`  Result: ${r1.success ? "ACCEPTED" : "REJECTED"}`);
  if (r1.success) {
    const { config } = await getState();
    log(`  New price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)}`);
    log(`  New timestamp: ${config.authorityTimestamp.toString()}`);
  } else {
    log(`  Error: ${r1.error?.slice(0, 60)}`);
  }

  // ===== TEST 2: Future Timestamp =====
  log("\n=== TEST 2: Future Timestamp ===");

  const futureTimestamp = BigInt(currentUnix + 86400 * 365); // 1 year in future
  log(`Attempting price push with timestamp 1 year in future...`);

  const r2 = await pushPriceWithTimestamp(50, futureTimestamp);
  log(`  Result: ${r2.success ? "ACCEPTED" : "REJECTED"}`);
  if (r2.success) {
    const { config } = await getState();
    log(`  New price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)}`);
    log(`  New timestamp: ${config.authorityTimestamp.toString()}`);
  } else {
    log(`  Error: ${r2.error?.slice(0, 60)}`);
  }

  // ===== TEST 3: Zero Timestamp =====
  log("\n=== TEST 3: Zero Timestamp ===");

  const r3 = await pushPriceWithTimestamp(200, 0n);
  log(`  Result: ${r3.success ? "ACCEPTED" : "REJECTED"}`);
  if (r3.success) {
    const { config } = await getState();
    log(`  New price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)}`);
    log(`  New timestamp: ${config.authorityTimestamp.toString()}`);
  } else {
    log(`  Error: ${r3.error?.slice(0, 60)}`);
  }

  // ===== TEST 4: Max Timestamp =====
  log("\n=== TEST 4: Max i64 Timestamp ===");

  const maxTimestamp = 9223372036854775807n; // i64::MAX
  const r4 = await pushPriceWithTimestamp(100, maxTimestamp);
  log(`  Result: ${r4.success ? "ACCEPTED" : "REJECTED"}`);
  if (r4.success) {
    const { config } = await getState();
    log(`  New price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)}`);
    log(`  New timestamp: ${config.authorityTimestamp.toString()}`);
  } else {
    log(`  Error: ${r4.error?.slice(0, 60)}`);
  }

  // ===== TEST 5: Sequence Attack (Old after New) =====
  log("\n=== TEST 5: Timestamp Sequence Attack ===");

  // First set a recent timestamp
  const recentTs = BigInt(currentUnix);
  log(`Setting price $150 with current timestamp...`);
  await pushPriceWithTimestamp(150, recentTs);
  await crank();

  // Now try to push with older timestamp
  const olderTs = BigInt(currentUnix - 3600); // 1 hour ago
  log(`Attempting to push $10 with older timestamp...`);
  const r5 = await pushPriceWithTimestamp(10, olderTs);
  log(`  Result: ${r5.success ? "ACCEPTED (vulnerability!)" : "REJECTED (correct)"}`);

  if (r5.success) {
    const { config } = await getState();
    log(`  *** WARNING: Price changed to $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)} with older timestamp! ***`);
  }

  // ===== FINAL STATE =====
  log("\n=== FINAL STATE ===");

  // Reset to normal price
  await pushPriceWithTimestamp(150, BigInt(currentUnix));
  await crank();

  const { vaultBalance: v2, config: c2 } = await getState();

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)} (Δ = ${(v2 - v1).toFixed(6)})`);
  log(`Price: $${(Number(c2.authorityPriceE6) / 1e6).toFixed(2)}`);
  log(`Timestamp: ${c2.authorityTimestamp.toString()}`);

  if (Math.abs(v2 - v1) > 0.001) {
    log("\n*** VAULT CHANGED DURING TIMESTAMP ATTACKS ***");
  } else {
    log("\nTimestamp manipulation did not affect vault");
  }

  // Summary
  log("\n=== SUMMARY ===");
  log("Old timestamp (replay): " + (r1.success ? "ACCEPTED" : "rejected"));
  log("Future timestamp: " + (r2.success ? "ACCEPTED" : "rejected"));
  log("Zero timestamp: " + (r3.success ? "ACCEPTED" : "rejected"));
  log("Max timestamp: " + (r4.success ? "ACCEPTED" : "rejected"));
  log("Old after new (sequence): " + (r5.success ? "ACCEPTED (!!!)" : "rejected"));
}

main().catch(console.error);
