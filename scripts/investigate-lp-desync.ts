/**
 * Investigate LP Position Desync
 *
 * Finding: LP position = -3,394,330,890,648
 *          User sum    =  3,394,330,790,648
 *          Difference  =            100,000 (exactly min_liquidation_abs!)
 *
 * Hypothesis: Dust position force-closes don't unwind LP positions
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function investigate() {
  console.log('=== LP POSITION DESYNC INVESTIGATION ===\n');

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  // Get all accounts
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({ idx, ...acc });
  }

  // Find LP
  const lpAccount = accounts.find(a => a.kind === AccountKind.LP);
  const lpPosition = BigInt(lpAccount?.positionSize || 0);
  const netLpPos = BigInt(engine.netLpPos || 0);

  console.log('Engine State:');
  console.log(`  net_lp_pos:              ${netLpPos}`);
  console.log(`  lp_sum_abs:              ${engine.lpSumAbs}`);
  console.log(`  total_open_interest:     ${engine.totalOpenInterest}`);
  console.log(`  lifetime_force_closes:   ${engine.lifetimeForceRealizeCloses}`);
  console.log(`  lifetime_liquidations:   ${engine.lifetimeLiquidations}`);
  console.log();

  console.log('LP Account:');
  console.log(`  position_size:           ${lpPosition}`);
  console.log(`  Matches net_lp_pos:      ${lpPosition === netLpPos}`);
  console.log();

  // Sum user positions
  let userPositionSum = 0n;
  console.log('User Accounts:');
  for (const acc of accounts) {
    if (acc.kind === AccountKind.User) {
      const pos = BigInt(acc.positionSize || 0);
      userPositionSum += pos;
      console.log(`  Account ${acc.idx}: position = ${pos}`);
    }
  }
  console.log(`  User position sum:       ${userPositionSum}`);
  console.log();

  // Calculate mismatch
  const expectedLpPos = -userPositionSum;
  const mismatch = lpPosition - expectedLpPos;

  console.log('Mismatch Analysis:');
  console.log(`  LP position:             ${lpPosition}`);
  console.log(`  Expected (=-users):      ${expectedLpPos}`);
  console.log(`  Mismatch:                ${mismatch}`);
  console.log(`  min_liquidation_abs:     ${params.minLiquidationAbs}`);
  console.log(`  Mismatch == min_liq?     ${mismatch === BigInt(params.minLiquidationAbs || 0)}`);
  console.log();

  // Calculate OI consistency
  let calculatedOI = 0n;
  for (const acc of accounts) {
    const pos = BigInt(acc.positionSize || 0);
    calculatedOI += pos < 0n ? -pos : pos;
  }

  console.log('OI Consistency:');
  console.log(`  Reported OI:             ${engine.totalOpenInterest}`);
  console.log(`  Calculated OI:           ${calculatedOI}`);
  console.log(`  Match:                   ${BigInt(engine.totalOpenInterest || 0) === calculatedOI}`);
  console.log();

  // Impact analysis
  console.log('Impact Analysis:');

  // The mismatch means LP has extra short exposure
  // If price goes UP: LP loses more than users gain
  // If price goes DOWN: LP gains more than users lose
  const orphanedNotional = Number(mismatch < 0n ? -mismatch : mismatch) * 7700 / 1e6;
  console.log(`  Orphaned LP position:    ${mismatch} units`);
  console.log(`  Orphaned notional:       ${orphanedNotional.toFixed(6)} SOL`);
  console.log();

  // Root cause hypothesis
  console.log('Root Cause Hypothesis:');
  console.log(`  lifetime_force_closes = ${engine.lifetimeForceRealizeCloses}`);
  console.log('  When dust positions are force-closed by crank:');
  console.log('  1. User position is zeroed');
  console.log('  2. OI is reduced by user\'s abs position');
  console.log('  3. LP position is NOT adjusted (it was the original counterparty)');
  console.log('  4. This creates orphaned LP position = dust amount');
  console.log();

  if (Number(engine.lifetimeForceRealizeCloses || 0) > 0) {
    const avgDust = Number(mismatch < 0n ? -mismatch : mismatch) / Number(engine.lifetimeForceRealizeCloses || 1);
    console.log(`  Avg dust per force close: ${avgDust.toFixed(0)} units`);
  }

  // Severity assessment
  console.log('Severity Assessment:');
  const vaultLamports = 6217409811n; // from state.json
  const orphanedRisk = BigInt(Math.floor(orphanedNotional * 1e9));
  const riskPercent = Number(orphanedRisk * 100n / vaultLamports);
  console.log(`  Orphaned risk:           ${orphanedNotional.toFixed(6)} SOL`);
  console.log(`  As % of vault:           ${riskPercent.toFixed(4)}%`);
  console.log();

  if (mismatch !== 0n) {
    console.log('FINDING: LP position desync detected!');
    console.log('This appears to be caused by dust position force-closes.');
    console.log('The LP has orphaned position that doesn\'t match user sum.');
    console.log('Impact: Small PnL leakage over time (LP bears extra risk).');
  } else {
    console.log('No desync detected - LP matches user sum.');
  }
}

investigate().catch(console.error);
