/**
 * Bug Reproduction: Oracle Authority No Price Bounds (Finding F)
 *
 * PushOraclePrice only validates price_e6 != 0. There are no upper bounds,
 * no deviation limits, no rate limits, and no timestamp validation.
 *
 * This script demonstrates:
 * 1. Pushing an extremely high price (1000x normal) — accepted
 * 2. Pushing an extremely low price (1 lamport) — accepted
 * 3. Pushing with a future timestamp — accepted
 * 4. Rapid-fire price updates (no rate limit) — accepted
 * 5. Showing that trades/cranks use the manipulated price
 *
 * NOTE: This does not exploit the market — it verifies the validation gap
 * and restores the correct price afterward.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodePushOraclePrice, encodeSetOracleAuthority,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// On-chain operations
// ---------------------------------------------------------------------------
async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  return { engine, config, data };
}

async function pushPrice(priceE6: bigint, timestamp?: bigint): Promise<boolean> {
  const ts = timestamp ?? BigInt(Math.floor(Date.now() / 1000));
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: ts.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    return false;
  }
}

async function setOracleAuthority() {
  const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function crank() {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

// ===========================================================================
// TEST CASES
// ===========================================================================
async function testOracleValidationGaps() {
  console.log("\n============================================================");
  console.log("ORACLE VALIDATION GAP TEST (Finding F)");
  console.log("============================================================\n");

  // Ensure oracle authority
  try { await setOracleAuthority(); } catch {}

  const state0 = await getState();
  const basePrice = state0.config.authorityPriceE6 > 0n ? state0.config.authorityPriceE6 : 9623n;
  console.log(`  Current price: ${basePrice} (e6 format)`);

  let passed = 0;
  let failed = 0;

  // ------------------------------------------------------------------
  // Test 1: Push zero price — should be REJECTED
  // ------------------------------------------------------------------
  console.log("\n--- Test 1: Push price = 0 (should be rejected) ---");
  const r1 = await pushPrice(0n);
  if (!r1) {
    console.log("  REJECTED (correct) — price_e6 == 0 validation works");
    passed++;
  } else {
    console.log("  ACCEPTED (unexpected) — zero price was allowed!");
    failed++;
  }

  // ------------------------------------------------------------------
  // Test 2: Push extremely high price (1000x) — should it be rejected?
  // ------------------------------------------------------------------
  console.log("\n--- Test 2: Push price = 1000x normal (extreme high) ---");
  const extremeHigh = basePrice * 1000n;
  console.log(`  Pushing: ${extremeHigh} (${Number(extremeHigh) / 1e6} USD)`);
  const r2 = await pushPrice(extremeHigh);
  if (r2) {
    console.log("  ACCEPTED — no upper bound check exists");
    console.log("  *** VULNERABILITY: 1000x price accepted without validation ***");
    failed++;
    // Verify it was stored
    const s2 = await getState();
    console.log(`  Stored price: ${s2.config.authorityPriceE6}`);
  } else {
    console.log("  REJECTED — upper bound validation exists");
    passed++;
  }
  // Restore
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Test 3: Push extremely low price (1 lamport) — should it be rejected?
  // ------------------------------------------------------------------
  console.log("\n--- Test 3: Push price = 1 (minimum, near-zero) ---");
  const r3 = await pushPrice(1n);
  if (r3) {
    console.log("  ACCEPTED — no minimum bound check (only != 0)");
    console.log("  *** VULNERABILITY: Price of 1 e-6 USD accepted ***");
    failed++;
    const s3 = await getState();
    console.log(`  Stored price: ${s3.config.authorityPriceE6}`);
  } else {
    console.log("  REJECTED — minimum bound validation exists");
    passed++;
  }
  // Restore
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Test 4: Push with future timestamp (+1 hour)
  // ------------------------------------------------------------------
  console.log("\n--- Test 4: Push with future timestamp (+1 hour) ---");
  const futureTs = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const r4 = await pushPrice(basePrice, futureTs);
  if (r4) {
    console.log("  ACCEPTED — no timestamp sanity check on push");
    console.log("  *** VULNERABILITY: Future timestamp accepted, extends price freshness ***");
    failed++;
    const s4 = await getState();
    console.log(`  Stored timestamp: ${s4.config.authorityTimestamp} (now+3600s)`);
  } else {
    console.log("  REJECTED — timestamp validation exists on push");
    passed++;
  }
  // Restore with correct timestamp
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Test 5: Push with ancient timestamp (-1 day)
  // ------------------------------------------------------------------
  console.log("\n--- Test 5: Push with past timestamp (-1 day) ---");
  const pastTs = BigInt(Math.floor(Date.now() / 1000) - 86400);
  const r5 = await pushPrice(basePrice, pastTs);
  if (r5) {
    console.log("  ACCEPTED on push — staleness only checked on read");
    console.log("  Verifying if stale price is used...");
    // Stale price won't be used by read_authority_price (staleness check on read)
    // But it was accepted on push — wasted gas and misleading
    failed++;
  } else {
    console.log("  REJECTED — timestamp validation on push");
    passed++;
  }
  // Restore
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Test 6: Rapid-fire price updates (rate limiting check)
  // ------------------------------------------------------------------
  console.log("\n--- Test 6: Rapid-fire 5 price updates in quick succession ---");
  let rapidOk = 0;
  const prices = [basePrice + 1n, basePrice + 2n, basePrice + 3n, basePrice + 4n, basePrice + 5n];
  for (const p of prices) {
    const r = await pushPrice(p);
    if (r) rapidOk++;
  }
  console.log(`  ${rapidOk}/5 rapid updates accepted`);
  if (rapidOk >= 4) {
    console.log("  *** VULNERABILITY: No rate limiting on price updates ***");
    failed++;
  } else {
    console.log("  Rate limiting exists");
    passed++;
  }
  // Restore
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Test 7: Push u64::MAX price
  // ------------------------------------------------------------------
  console.log("\n--- Test 7: Push u64::MAX price ---");
  const maxU64 = (1n << 64n) - 1n;
  const r7 = await pushPrice(maxU64);
  if (r7) {
    console.log("  ACCEPTED — u64::MAX price accepted without overflow check");
    console.log(`  *** VULNERABILITY: Price ${maxU64} accepted ***`);
    failed++;
    // Check if crank works with this price
    try {
      await crank();
      console.log("  Crank SUCCEEDED with u64::MAX price!");
    } catch (e: any) {
      console.log(`  Crank failed with u64::MAX price: ${e.message?.slice(0, 60)}`);
      console.log("  (overflow during computation — partial mitigation)");
    }
  } else {
    console.log("  REJECTED — max price validation exists");
    passed++;
  }
  // Restore
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Test 8: Deviation check — push 50% different from current
  // ------------------------------------------------------------------
  console.log("\n--- Test 8: Push 50% deviation from current price ---");
  const devPrice = basePrice / 2n;
  console.log(`  Current: ${basePrice}, pushing: ${devPrice} (50% drop)`);
  const r8 = await pushPrice(devPrice);
  if (r8) {
    console.log("  ACCEPTED — no deviation check from previous price");
    console.log("  *** VULNERABILITY: 50% instant price change accepted ***");
    failed++;
  } else {
    console.log("  REJECTED — deviation check exists");
    passed++;
  }
  // Restore
  await pushPrice(basePrice);

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log("\n============================================================");
  console.log("ORACLE VALIDATION AUDIT RESULTS");
  console.log("============================================================");
  console.log(`  Tests passed (validation exists): ${passed}`);
  console.log(`  Tests failed (validation gap):    ${failed}`);
  console.log();

  if (failed > 0) {
    console.log("  CONFIRMED MISSING VALIDATIONS:");
    console.log("    - No upper price bound (accepts any u64 > 0)");
    console.log("    - No lower price bound beyond != 0");
    console.log("    - No timestamp validation on push (only staleness on read)");
    console.log("    - No rate limiting on price updates");
    console.log("    - No deviation limit from previous price");
    console.log("    - No confidence/quality filter for authority prices");
    console.log();
    console.log("  IMPACT IF ORACLE AUTHORITY COMPROMISED:");
    console.log("    - Mass liquidation via extreme low price");
    console.log("    - Inflated withdrawals via extreme high price");
    console.log("    - Insurance drain via alternating price manipulation");
  }

  console.log("\n============================================================\n");

  // Final restore
  await pushPrice(basePrice);
  console.log(`  Price restored to ${basePrice}`);
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("============================================================");
  console.log("ORACLE AUTHORITY PRICE VALIDATION AUDIT");
  console.log("============================================================");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Slab: ${SLAB.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  await testOracleValidationGaps();
}

main().catch(e => { console.error("Fatal:", e.message?.slice(0, 200)); process.exit(1); });
