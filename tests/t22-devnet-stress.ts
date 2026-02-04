/**
 * T22: Devnet Stress Test
 *
 * Stress tests the deployed percolator market on devnet:
 * - Multiple rapid cranks
 * - Oracle price updates (for admin oracle markets)
 * - Price + crank sequences
 *
 * Run with: npx tsx tests/t22-devnet-stress.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";

// ============================================================================
// CONSTANTS
// ============================================================================

// Default RPC (can override with SOLANA_RPC_URL env var)
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Program IDs
const PERCOLATOR_PROGRAM_ID = new PublicKey("46iB4ET4WpqfTXAqGSmyBczLBgVhd1sHre93KtU3sTg9");
const VAMM_MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");

// Existing deployed market
const MARKET_SLAB = new PublicKey("AcF3Q3UMHqx2xZR2Ty6pNvfCaogFmsLEqyMACQ2c4UPK");
const MARKET_VAULT = new PublicKey("D7QrsrJ4emtsw5LgPGY2coM5K9WPPVgQNJVr5TbK7qtU");
const MATCHER_CONTEXT = new PublicKey("Gspp8GZtHhYR1kWsZ9yMtAhMiPXk5MF9sRdRrSycQJio");

// Pyth devnet SOL/USD feed (for crank)
const PYTH_SOL_USD = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");

// ============================================================================
// INSTRUCTION ENCODERS
// ============================================================================

function encodeCrank(): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt8(5, 0); // KeeperCrank tag
  data.writeUInt16LE(65535, 1); // u16::MAX = permissionless
  data.writeUInt8(0, 3); // allow_panic = false
  return data;
}

function encodeSetOracleAuthority(authority: PublicKey): Buffer {
  const data = Buffer.alloc(33);
  data.writeUInt8(16, 0); // SetOracleAuthority tag
  authority.toBuffer().copy(data, 1);
  return data;
}

function encodePushOraclePrice(priceE6: bigint, timestamp: bigint): Buffer {
  const data = Buffer.alloc(17);
  data.writeUInt8(17, 0); // PushOraclePrice tag
  data.writeBigUInt64LE(priceE6, 1);
  data.writeBigInt64LE(timestamp, 9);
  return data;
}

// ============================================================================
// HELPERS
// ============================================================================

function loadKeypair(): Keypair {
  const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
  const keypairBytes = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// STRESS TESTS
// ============================================================================

interface StressResults {
  crankSuccess: number;
  crankFail: number;
  priceSuccess: number;
  priceFail: number;
  rapidSuccess: number;
  rapidFail: number;
}

async function runCrankStress(
  connection: Connection,
  payer: Keypair,
  count: number
): Promise<{ success: number; fail: number }> {
  console.log(`\n--- Stress Test: ${count} Cranks ---`);
  let success = 0;
  let fail = 0;

  for (let i = 0; i < count; i++) {
    try {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
        {
          programId: PERCOLATOR_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: MARKET_SLAB, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: PYTH_SOL_USD, isSigner: false, isWritable: false },
          ],
          data: encodeCrank(),
        }
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      success++;
      console.log(`Crank ${i + 1}/${count}: ${sig.slice(0, 16)}... SUCCESS`);
    } catch (e: any) {
      fail++;
      console.log(`Crank ${i + 1}/${count}: FAILED - ${e.message?.slice(0, 50)}`);
    }

    await sleep(500);
  }

  console.log(`\nCrank results: ${success} success, ${fail} failed out of ${count}`);
  return { success, fail };
}

async function runPriceStress(
  connection: Connection,
  payer: Keypair,
  prices: number[]
): Promise<{ success: number; fail: number }> {
  console.log(`\n--- Stress Test: ${prices.length} Price Updates ---`);
  let success = 0;
  let fail = 0;

  for (let i = 0; i < prices.length; i++) {
    const priceE6 = BigInt(prices[i]);
    const timestamp = BigInt(Math.floor(Date.now() / 1000));

    try {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
        {
          programId: PERCOLATOR_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: MARKET_SLAB, isSigner: false, isWritable: true },
          ],
          data: encodePushOraclePrice(priceE6, timestamp),
        }
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      success++;
      console.log(
        `Price ${i + 1}/${prices.length}: $${(prices[i] / 1_000_000).toFixed(2)} - ${sig.slice(0, 16)}... SUCCESS`
      );
    } catch (e: any) {
      fail++;
      console.log(
        `Price ${i + 1}/${prices.length}: $${(prices[i] / 1_000_000).toFixed(2)} FAILED - ${e.message?.slice(0, 50)}`
      );
    }

    await sleep(500);
  }

  console.log(`\nPrice update results: ${success} success, ${fail} failed out of ${prices.length}`);
  return { success, fail };
}

async function runRapidSequence(
  connection: Connection,
  payer: Keypair,
  count: number
): Promise<{ success: number; fail: number }> {
  console.log(`\n--- Stress Test: ${count} Rapid Price+Crank Sequences ---`);
  let success = 0;
  let fail = 0;

  for (let i = 0; i < count; i++) {
    const priceE6 = BigInt(130_000_000 + i * 5_000_000); // $130, $135, $140...
    const timestamp = BigInt(Math.floor(Date.now() / 1000));

    try {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
        // Push price
        {
          programId: PERCOLATOR_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: MARKET_SLAB, isSigner: false, isWritable: true },
          ],
          data: encodePushOraclePrice(priceE6, timestamp),
        },
        // Crank immediately
        {
          programId: PERCOLATOR_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: MARKET_SLAB, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: PYTH_SOL_USD, isSigner: false, isWritable: false },
          ],
          data: encodeCrank(),
        }
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      success++;
      console.log(
        `Rapid ${i + 1}/${count}: Price $${Number(priceE6) / 1_000_000} + Crank - ${sig.slice(0, 16)}... SUCCESS`
      );
    } catch (e: any) {
      fail++;
      console.log(`Rapid ${i + 1}/${count}: FAILED - ${e.message?.slice(0, 50)}`);
    }

    await sleep(300);
  }

  console.log(`\nRapid sequence results: ${success} success, ${fail} failed out of ${count}`);
  return { success, fail };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n=== DEVNET STRESS TEST ===\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();

  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Program:", PERCOLATOR_PROGRAM_ID.toBase58());
  console.log("Market:", MARKET_SLAB.toBase58());

  // Check balance
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  if (balance < 100_000_000) {
    console.log("ERROR: Insufficient balance (need at least 0.1 SOL)");
    process.exit(1);
  }

  // Verify slab exists
  const slabInfo = await connection.getAccountInfo(MARKET_SLAB);
  if (!slabInfo) {
    console.log("ERROR: Market slab not found at", MARKET_SLAB.toBase58());
    process.exit(1);
  }
  console.log(`Slab account: ${slabInfo.data.length} bytes, owner: ${slabInfo.owner.toBase58()}`);

  if (!slabInfo.owner.equals(PERCOLATOR_PROGRAM_ID)) {
    console.log("ERROR: Slab owner mismatch");
    process.exit(1);
  }

  // Run stress tests
  const results: StressResults = {
    crankSuccess: 0,
    crankFail: 0,
    priceSuccess: 0,
    priceFail: 0,
    rapidSuccess: 0,
    rapidFail: 0,
  };

  // Test 1: Multiple cranks
  const crankResults = await runCrankStress(connection, payer, 10);
  results.crankSuccess = crankResults.success;
  results.crankFail = crankResults.fail;

  // Test 2: Price updates (requires oracle authority)
  const prices = [130_000_000, 135_000_000, 140_000_000, 145_000_000, 138_000_000];
  const priceResults = await runPriceStress(connection, payer, prices);
  results.priceSuccess = priceResults.success;
  results.priceFail = priceResults.fail;

  // Test 3: Rapid price + crank sequences
  const rapidResults = await runRapidSequence(connection, payer, 5);
  results.rapidSuccess = rapidResults.success;
  results.rapidFail = rapidResults.fail;

  // Summary
  console.log("\n=== STRESS TEST SUMMARY ===");
  console.log(`Cranks: ${results.crankSuccess}/${results.crankSuccess + results.crankFail} successful`);
  console.log(`Price Updates: ${results.priceSuccess}/${results.priceSuccess + results.priceFail} successful`);
  console.log(`Rapid Sequences: ${results.rapidSuccess}/${results.rapidSuccess + results.rapidFail} successful`);

  const totalOps =
    results.crankSuccess +
    results.crankFail +
    results.priceSuccess +
    results.priceFail +
    results.rapidSuccess +
    results.rapidFail;
  const totalSuccess = results.crankSuccess + results.priceSuccess + results.rapidSuccess;

  console.log(`\nTotal: ${totalSuccess}/${totalOps} operations successful (${((totalSuccess / totalOps) * 100).toFixed(1)}%)`);

  if (totalSuccess === totalOps) {
    console.log("\n✓ STRESS TEST PASSED: All operations completed successfully");
  } else {
    console.log("\n⚠ STRESS TEST PARTIAL: Some operations failed");
    console.log("  (Price updates may fail if payer is not oracle authority)");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
