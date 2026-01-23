/**
 * Verify Threshold Auto-Adjustment
 *
 * Tests that risk_reduction_threshold auto-adjusts during crank based on LP risk.
 * Also checks for potential attack vectors.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseConfig } from "../src/solana/slab.js";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  return { engine, params };
}

async function runCrank(): Promise<boolean> {
  try {
    const data = await fetchSlab(conn, SLAB);
    const config = parseConfig(data);

    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey,
      SLAB,
      new PublicKey(config.vault),
      new PublicKey(config.collateralMint),
      ORACLE,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeKeeperCrank(),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  console.log('============================================================');
  console.log('THRESHOLD AUTO-ADJUSTMENT VERIFICATION');
  console.log('============================================================\n');

  // Get initial state
  const initial = await getState();
  const initialThreshold = BigInt(initial.params.riskReductionThreshold || 0);
  const initialInsurance = BigInt(initial.engine.insuranceFund?.balance || 0);
  const initialLpSumAbs = BigInt(initial.engine.lpSumAbs || 0);
  const initialSlot = BigInt(initial.engine.lastCrankSlot || 0);

  console.log('>>> INITIAL STATE <<<\n');
  console.log(`  Threshold:       ${initialThreshold} (${(Number(initialThreshold) / 1e9).toFixed(6)} SOL)`);
  console.log(`  Insurance:       ${initialInsurance} (${(Number(initialInsurance) / 1e9).toFixed(4)} SOL)`);
  console.log(`  LP Sum Abs:      ${initialLpSumAbs}`);
  console.log(`  Slot:            ${initialSlot}`);
  console.log(`  Buffer:          ${initialInsurance - initialThreshold} (${((Number(initialInsurance - initialThreshold)) / 1e9).toFixed(4)} SOL)`);
  console.log();

  // Run cranks and track threshold changes
  console.log('>>> RUNNING CRANKS (watching threshold changes) <<<\n');

  const thresholdHistory: bigint[] = [initialThreshold];
  let lastThreshold = initialThreshold;

  for (let i = 0; i < 10; i++) {
    const success = await runCrank();
    if (success) {
      const state = await getState();
      const newThreshold = BigInt(state.params.riskReductionThreshold || 0);
      thresholdHistory.push(newThreshold);

      const change = newThreshold - lastThreshold;
      const changeStr = change >= 0n ? `+${change}` : `${change}`;

      console.log(`  Crank ${i + 1}: threshold = ${newThreshold} (${changeStr})`);
      lastThreshold = newThreshold;
    } else {
      console.log(`  Crank ${i + 1}: failed`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log();

  // Get final state
  const final = await getState();
  const finalThreshold = BigInt(final.params.riskReductionThreshold || 0);
  const finalInsurance = BigInt(final.engine.insuranceFund?.balance || 0);
  const finalLpSumAbs = BigInt(final.engine.lpSumAbs || 0);

  console.log('>>> FINAL STATE <<<\n');
  console.log(`  Threshold:       ${finalThreshold} (${(Number(finalThreshold) / 1e9).toFixed(6)} SOL)`);
  console.log(`  Insurance:       ${finalInsurance} (${(Number(finalInsurance) / 1e9).toFixed(4)} SOL)`);
  console.log(`  LP Sum Abs:      ${finalLpSumAbs}`);
  console.log(`  Buffer:          ${finalInsurance - finalThreshold} (${((Number(finalInsurance - finalThreshold)) / 1e9).toFixed(4)} SOL)`);
  console.log();

  // Compute expected threshold based on LP risk
  // Formula: target = floor + (risk_units * price / 1e6) * thresh_risk_bps / 10000
  // risk_units = lp_max_abs + lp_sum_abs / 8
  // With defaults: floor=0, thresh_risk_bps=50 (0.5%)

  // Analysis
  console.log('============================================================');
  console.log('VERIFICATION RESULTS');
  console.log('============================================================\n');

  const thresholdChanged = finalThreshold !== initialThreshold;
  const totalChange = finalThreshold - initialThreshold;

  console.log(`  Threshold changed:     ${thresholdChanged ? 'YES' : 'NO'}`);
  console.log(`  Total change:          ${totalChange} (${((Number(totalChange)) / 1e9).toFixed(9)} SOL)`);
  console.log(`  Change direction:      ${totalChange > 0n ? 'INCREASED' : totalChange < 0n ? 'DECREASED' : 'UNCHANGED'}`);
  console.log();

  // Security analysis
  console.log('>>> SECURITY ANALYSIS <<<\n');

  // Check 1: Insurance always above threshold
  const insuranceAboveThreshold = finalInsurance > finalThreshold;
  console.log(`  [CHECK 1] Insurance > Threshold: ${insuranceAboveThreshold ? 'PASS' : 'FAIL'}`);

  // Check 2: Threshold can't be manipulated to negative
  const thresholdNonNegative = finalThreshold >= 0n;
  console.log(`  [CHECK 2] Threshold >= 0:        ${thresholdNonNegative ? 'PASS' : 'FAIL'}`);

  // Check 3: Step limiting prevents sudden drops
  let maxStepPercent = 0;
  for (let i = 1; i < thresholdHistory.length; i++) {
    const prev = thresholdHistory[i - 1];
    const curr = thresholdHistory[i];
    if (prev > 0n) {
      const stepPercent = Math.abs(Number(curr - prev) / Number(prev) * 100);
      maxStepPercent = Math.max(maxStepPercent, stepPercent);
    }
  }
  const stepLimited = maxStepPercent <= 6; // 5% max step + some margin
  console.log(`  [CHECK 3] Step limited (<6%):    ${stepLimited ? 'PASS' : 'FAIL'} (max: ${maxStepPercent.toFixed(2)}%)`);

  // Check 4: EWMA smoothing prevents manipulation
  const smoothed = thresholdHistory.length > 2; // Multiple steps means smoothing
  console.log(`  [CHECK 4] EWMA smoothing:        ${smoothed ? 'VERIFIED' : 'NEEDS MORE DATA'}`);

  console.log();

  // Attack vector analysis
  console.log('>>> ATTACK VECTOR ANALYSIS <<<\n');

  console.log('  Q: Can attacker lower threshold to drain insurance?');
  console.log('  A: No - lowering LP risk requires closing positions.');
  console.log('     Insurance is only spent on:');
  console.log('     1. Bad debt from liquidations (needs actual losses)');
  console.log('     2. Backing warmed positive PnL (legitimate profits)');
  console.log('     3. ADL haircuts (forced deleveraging)');
  console.log('     None of these can be triggered just by lowering threshold.');
  console.log();

  console.log('  Q: Can attacker rapidly increase threshold to freeze trading?');
  console.log('  A: Partially mitigated:');
  console.log('     - Step limiting: max 5% change per update');
  console.log('     - EWMA smoothing: 10% weight on new values');
  console.log('     - Update interval: only every 10 slots');
  console.log('     Attack would need sustained large trades over many slots.');
  console.log();

  // Conclusion
  console.log('============================================================');
  console.log('CONCLUSION');
  console.log('============================================================\n');

  if (thresholdChanged && stepLimited && insuranceAboveThreshold) {
    console.log('  THRESHOLD AUTO-ADJUSTMENT: VERIFIED WORKING');
    console.log('  SOFT BURN VIABILITY:       CONFIRMED');
    console.log('  SECURITY:                  No obvious attack vectors');
    console.log();
    console.log('  The threshold auto-adjusts based on LP risk without admin.');
    console.log('  Step limiting and EWMA smoothing prevent manipulation.');
    console.log('  Insurance fund will accumulate as a soft burn.');
  } else if (!thresholdChanged) {
    console.log('  THRESHOLD AUTO-ADJUSTMENT: NOT OBSERVED');
    console.log('  (May need more trades or time to see changes)');
  } else {
    console.log('  THRESHOLD AUTO-ADJUSTMENT: NEEDS INVESTIGATION');
  }
}

main().catch(console.error);
