/**
 * Test Threshold Increases with LP Risk
 *
 * Verifies that threshold goes UP when LP takes on more risk.
 * This is critical for the soft burn mechanism to scale properly.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const config = parseConfig(data);

  let lpIdx = -1, userIdx = -1;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      if (acc.kind === AccountKind.LP && lpIdx < 0) lpIdx = idx;
      if (acc.kind === AccountKind.User && userIdx < 0) userIdx = idx;
    }
  }

  return {
    threshold: BigInt(params.riskReductionThreshold || 0),
    insurance: BigInt(engine.insuranceFund?.balance || 0),
    lpSumAbs: BigInt(engine.lpSumAbs || 0),
    netLpPos: BigInt(engine.netLpPos || 0),
    config,
    lpIdx,
    userIdx,
  };
}

async function runCrank(): Promise<boolean> {
  try {
    const { config } = await getState();
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, SLAB, new PublicKey(config.vault),
      new PublicKey(config.collateralMint), ORACLE,
      TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
    ]);
    const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank() });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function executeTrade(lpIdx: number, userIdx: number, size: bigint): Promise<boolean> {
  try {
    const matcherCtx = new PublicKey(marketInfo.matcherCtx);
    const lpPda = new PublicKey(marketInfo.lpPda);

    // ACCOUNTS_TRADE_CPI: user, lpOwner, slab, clock, oracle, matcherProg, matcherCtx, lpPda
    const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey,       // user
      payer.publicKey,       // lpOwner (same wallet)
      SLAB,                  // slab
      SYSVAR_CLOCK_PUBKEY,   // clock
      ORACLE,                // oracle
      MATCHER_PROGRAM,       // matcherProg
      matcherCtx,            // matcherCtx
      lpPda,                 // lpPda
    ]);
    const ix = buildIx({
      programId: PROGRAM_ID, keys,
      data: encodeTradeCpi({ lpIdx, userIdx, size: size.toString() }),
    });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e) {
    console.log(`    Trade error: ${(e as Error).message?.slice(0, 50)}`);
    return false;
  }
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(6);
}

async function main() {
  console.log('============================================================');
  console.log('TEST: Threshold Increases with LP Risk');
  console.log('============================================================\n');

  // Get initial state
  const initial = await getState();
  console.log('>>> INITIAL STATE <<<');
  console.log(`  Threshold:  ${formatSol(initial.threshold)} SOL`);
  console.log(`  LP Sum Abs: ${initial.lpSumAbs}`);
  console.log(`  Net LP Pos: ${initial.netLpPos}`);
  console.log(`  LP idx: ${initial.lpIdx}, User idx: ${initial.userIdx}`);
  console.log();

  if (initial.lpIdx < 0 || initial.userIdx < 0) {
    console.log('ERROR: No LP or user account found');
    return;
  }

  // Run initial cranks to settle current state
  console.log('>>> RUNNING INITIAL CRANKS <<<');
  for (let i = 0; i < 3; i++) {
    await runCrank();
    await new Promise(r => setTimeout(r, 500));
  }

  const afterInitialCranks = await getState();
  console.log(`  Threshold after cranks: ${formatSol(afterInitialCranks.threshold)} SOL`);
  console.log();

  // Now INCREASE LP risk by opening large positions
  console.log('>>> INCREASING LP RISK (opening large positions) <<<');

  const tradeSize = 50_000_000_000n; // 50B units per trade
  let successfulTrades = 0;

  for (let i = 0; i < 10; i++) {
    // Always go LONG to keep increasing LP's short exposure
    const success = await executeTrade(initial.lpIdx, initial.userIdx, tradeSize);
    if (success) {
      successfulTrades++;
      process.stdout.write('+');
    } else {
      process.stdout.write('x');
    }

    // Run crank after each trade to update threshold
    await runCrank();
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log();
  console.log(`  Executed ${successfulTrades}/10 trades`);
  console.log();

  // Check state after trades
  const afterTrades = await getState();
  console.log('>>> STATE AFTER INCREASING RISK <<<');
  console.log(`  Threshold:  ${formatSol(afterTrades.threshold)} SOL`);
  console.log(`  LP Sum Abs: ${afterTrades.lpSumAbs}`);
  console.log(`  Net LP Pos: ${afterTrades.netLpPos}`);
  console.log();

  // Run more cranks to let threshold adjust
  console.log('>>> RUNNING CRANKS TO LET THRESHOLD ADJUST <<<');
  const thresholdHistory: bigint[] = [afterTrades.threshold];

  for (let i = 0; i < 10; i++) {
    await runCrank();
    const state = await getState();
    thresholdHistory.push(state.threshold);

    const change = state.threshold - thresholdHistory[thresholdHistory.length - 2];
    const sign = change >= 0n ? '+' : '';
    console.log(`  Crank ${i + 1}: threshold = ${formatSol(state.threshold)} (${sign}${change})`);

    await new Promise(r => setTimeout(r, 1000));
  }
  console.log();

  // Final state
  const final = await getState();

  // Analysis
  console.log('============================================================');
  console.log('RESULTS');
  console.log('============================================================\n');

  const thresholdChange = final.threshold - afterInitialCranks.threshold;
  const lpRiskChange = final.lpSumAbs - afterInitialCranks.lpSumAbs;

  console.log(`  Threshold change: ${formatSol(afterInitialCranks.threshold)} -> ${formatSol(final.threshold)}`);
  console.log(`  Delta:            ${thresholdChange >= 0n ? '+' : ''}${formatSol(thresholdChange)} SOL`);
  console.log();
  console.log(`  LP risk change:   ${afterInitialCranks.lpSumAbs} -> ${final.lpSumAbs}`);
  console.log(`  Delta:            ${lpRiskChange >= 0n ? '+' : ''}${lpRiskChange} units`);
  console.log();

  // Verify threshold increased with risk
  const thresholdIncreased = final.threshold > afterInitialCranks.threshold;
  const riskIncreased = final.lpSumAbs > afterInitialCranks.lpSumAbs;

  console.log('>>> VERIFICATION <<<');
  console.log(`  LP risk increased:     ${riskIncreased ? 'YES' : 'NO'}`);
  console.log(`  Threshold increased:   ${thresholdIncreased ? 'YES' : 'NO'}`);
  console.log();

  if (riskIncreased && thresholdIncreased) {
    console.log('✓ PASS: Threshold increases when LP risk increases');
    console.log('        Soft burn mechanism scales correctly with activity');
  } else if (!riskIncreased) {
    console.log('? INCONCLUSIVE: LP risk did not increase (trades may have failed)');
    console.log('                Need more margin or different trade direction');
  } else {
    console.log('✗ FAIL: Threshold did not increase with LP risk');
    console.log('        This could indicate a bug in threshold auto-adjustment');
  }
}

main().catch(console.error);
