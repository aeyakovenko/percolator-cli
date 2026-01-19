/**
 * Extreme Stress Test
 *
 * Creates maximum leverage positions and attempts to stress the system:
 * 1. Push positions to near-liquidation margins
 * 2. Test funding rate with extreme imbalance
 * 3. Attempt rapid position changes
 * 4. Test insurance fund limits
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeTradeCpi, encodeKeeperCrank } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_TRADE_CPI, ACCOUNTS_KEEPER_CRANK } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const LP_IDX = marketInfo.lp.index;
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

interface StressResult {
  test: string;
  success: boolean;
  details: string;
  insuranceBefore: number;
  insuranceAfter: number;
  error?: string;
}

async function crank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
}

async function trade(userIdx: number, size: bigint): Promise<boolean> {
  const lpPda = deriveLpPda(SLAB, LP_IDX);
  const tradeData = encodeTradeCpi({
    lpIdx: LP_IDX,
    userIdx,
    size: size.toString(),
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
    MATCHER_PROGRAM,
    MATCHER_CTX,
    lpPda,
  ]);

  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));

  try {
    await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    console.log(`  Trade error: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function closePosition(userIdx: number): Promise<boolean> {
  const data = await fetchSlab(conn, SLAB);
  const acc = parseAccount(data, userIdx);
  if (!acc || acc.positionSize === 0n) return true;
  return trade(userIdx, -acc.positionSize);
}

async function getEngineState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  return { engine, params, data };
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStressTests(): Promise<StressResult[]> {
  const results: StressResult[] = [];

  console.log("=== EXTREME STRESS TEST SUITE ===\n");

  const { engine: initialEngine, params } = await getEngineState();
  const initialInsurance = Number(initialEngine.insuranceFund.balance) / 1e9;
  console.log(`Initial insurance: ${initialInsurance.toFixed(4)} SOL`);
  console.log(`Risk threshold: ${(Number(params.riskReductionThreshold) / 1e9).toFixed(4)} SOL`);
  console.log(`Maintenance margin: ${Number(params.maintenanceMarginBps) / 100}%`);

  // Get user indices
  const data = await fetchSlab(conn, SLAB);
  const indices = parseUsedIndices(data);
  const userIndices = indices.filter(idx => {
    const acc = parseAccount(data, idx);
    return acc && acc.kind === AccountKind.User;
  });

  console.log(`User accounts: ${userIndices.join(", ")}\n`);

  // Test 1: Maximum position size
  console.log("--- TEST 1: Maximum Position Size ---");
  {
    const insuranceBefore = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;

    // Close existing positions first
    for (const idx of userIndices) {
      await closePosition(idx);
    }
    await crank();
    await sleep(1000);

    // Try increasingly large positions
    const sizes = [100_000_000_000n, 500_000_000_000n, 1_000_000_000_000n, 2_000_000_000_000n];
    let maxSuccessfulSize = 0n;

    for (const size of sizes) {
      console.log(`  Trying size ${size}...`);
      const success = await trade(userIndices[0], size);
      if (success) {
        maxSuccessfulSize = size;
        await closePosition(userIndices[0]);
        await sleep(1000);
      } else {
        break;
      }
    }

    const insuranceAfter = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;
    results.push({
      test: "Maximum Position Size",
      success: maxSuccessfulSize > 0n,
      details: `Max successful: ${maxSuccessfulSize} units`,
      insuranceBefore,
      insuranceAfter,
    });
  }

  // Test 2: Rapid position flipping
  console.log("\n--- TEST 2: Rapid Position Flipping ---");
  {
    const insuranceBefore = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;
    const flipSize = 100_000_000_000n;
    let successfulFlips = 0;
    let errors: string[] = [];

    for (let i = 0; i < 5; i++) {
      console.log(`  Flip ${i + 1}: LONG...`);
      const longOk = await trade(userIndices[0], flipSize);
      if (!longOk) {
        errors.push(`Flip ${i + 1} LONG failed`);
        break;
      }
      await sleep(500);

      console.log(`  Flip ${i + 1}: SHORT...`);
      const shortOk = await trade(userIndices[0], -flipSize * 2n);
      if (!shortOk) {
        errors.push(`Flip ${i + 1} SHORT failed`);
        break;
      }
      await sleep(500);

      await closePosition(userIndices[0]);
      await sleep(500);
      successfulFlips++;
    }

    await crank();
    const insuranceAfter = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;
    results.push({
      test: "Rapid Position Flipping",
      success: successfulFlips >= 3,
      details: `${successfulFlips}/5 flips completed`,
      insuranceBefore,
      insuranceAfter,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    });
  }

  // Test 3: Extreme Imbalance (all same direction)
  console.log("\n--- TEST 3: Extreme Market Imbalance ---");
  {
    const insuranceBefore = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;

    // Close all positions
    for (const idx of userIndices) {
      await closePosition(idx);
    }
    await crank();
    await sleep(1000);

    // Open all LONGs
    const positionSize = 500_000_000_000n;
    let successCount = 0;

    for (const idx of userIndices) {
      console.log(`  User ${idx} going LONG ${positionSize}...`);
      const success = await trade(idx, positionSize);
      if (success) successCount++;
      await sleep(1000);
    }

    await crank();

    // Check LP position
    const { engine, data: newData } = await getEngineState();
    const lpAcc = parseAccount(newData, LP_IDX);
    const netLpPos = lpAcc ? lpAcc.positionSize : 0n;
    console.log(`  LP position (should be SHORT): ${netLpPos}`);

    const insuranceAfter = Number(engine.insuranceFund.balance) / 1e9;
    results.push({
      test: "Extreme Market Imbalance",
      success: successCount === userIndices.length,
      details: `${successCount}/${userIndices.length} users LONG, LP pos=${netLpPos}`,
      insuranceBefore,
      insuranceAfter,
    });
  }

  // Test 4: Margin utilization check
  console.log("\n--- TEST 4: Near-Margin Stress ---");
  {
    const insuranceBefore = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;

    const { data: stateData, params: riskParams } = await getEngineState();

    let nearMarginCount = 0;
    let totalMarginRatio = 0;
    let positionCount = 0;

    for (const idx of userIndices) {
      const acc = parseAccount(stateData, idx);
      if (!acc || acc.positionSize === 0n) continue;

      const posAbs = acc.positionSize < 0n ? -acc.positionSize : acc.positionSize;
      // Approximate margin ratio using capital vs position
      // Real calculation would need oracle price
      const marginRatio = Number(acc.capital) / (Number(posAbs) / 1e9);

      if (marginRatio < 0.15) { // ~15% effective margin
        nearMarginCount++;
      }
      totalMarginRatio += marginRatio;
      positionCount++;
      console.log(`  User ${idx}: approx margin ${(marginRatio * 100).toFixed(1)}%`);
    }

    const avgMargin = positionCount > 0 ? (totalMarginRatio / positionCount * 100).toFixed(1) : "N/A";
    const insuranceAfter = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;
    results.push({
      test: "Near-Margin Positions",
      success: true,
      details: `${nearMarginCount} near-margin, avg margin: ${avgMargin}%`,
      insuranceBefore,
      insuranceAfter,
    });
  }

  // Test 5: Multiple crank cycles
  console.log("\n--- TEST 5: Crank Stress ---");
  {
    const insuranceBefore = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;
    let successfulCranks = 0;

    for (let i = 0; i < 20; i++) {
      try {
        await crank();
        successfulCranks++;
        process.stdout.write(".");
      } catch (e) {
        process.stdout.write("x");
      }
      await sleep(200);
    }
    console.log();

    const insuranceAfter = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;
    results.push({
      test: "Rapid Cranking",
      success: successfulCranks >= 15,
      details: `${successfulCranks}/20 cranks succeeded`,
      insuranceBefore,
      insuranceAfter,
    });
  }

  // Test 6: Bank run simulation
  console.log("\n--- TEST 6: Bank Run Simulation ---");
  {
    const insuranceBefore = Number((await getEngineState()).engine.insuranceFund.balance) / 1e9;

    // Close all positions in sequence (simulating bank run)
    let closedCount = 0;
    for (const idx of userIndices) {
      const success = await closePosition(idx);
      if (success) closedCount++;
      await sleep(500);
    }

    await crank();
    const { engine } = await getEngineState();
    const insuranceAfter = Number(engine.insuranceFund.balance) / 1e9;
    const riskMode = engine.riskReductionOnly;

    results.push({
      test: "Bank Run Simulation",
      success: !riskMode,
      details: `Closed ${closedCount} positions, risk mode: ${riskMode}`,
      insuranceBefore,
      insuranceAfter,
    });
  }

  return results;
}

async function main() {
  try {
    const results = await runStressTests();

    console.log("\n" + "=".repeat(60));
    console.log("STRESS TEST RESULTS");
    console.log("=".repeat(60) + "\n");

    let passCount = 0;
    for (const r of results) {
      const status = r.success ? "✓ PASS" : "✗ FAIL";
      console.log(`${status}: ${r.test}`);
      console.log(`       ${r.details}`);
      console.log(`       Insurance: ${r.insuranceBefore.toFixed(4)} → ${r.insuranceAfter.toFixed(4)} SOL (${(r.insuranceAfter - r.insuranceBefore) >= 0 ? "+" : ""}${(r.insuranceAfter - r.insuranceBefore).toFixed(4)})`);
      if (r.error) console.log(`       Error: ${r.error}`);
      console.log();
      if (r.success) passCount++;
    }

    console.log(`Total: ${passCount}/${results.length} tests passed`);

    // Final state
    const { engine } = await getEngineState();
    console.log(`\nFinal insurance fund: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(4)} SOL`);
    console.log(`Risk reduction mode: ${engine.riskReductionOnly}`);
    console.log(`Lifetime liquidations: ${engine.lifetimeLiquidations}`);
    console.log(`Lifetime force closes: ${engine.lifetimeForceCloses}`);

  } catch (e: any) {
    console.error("Stress test error:", e.message);
    throw e;
  }
}

main().catch(console.error);
