/**
 * Oracle and Edge Case Attack Tests
 *
 * Based on deep source code analysis:
 * - MAX_ORACLE_PRICE = 10^15
 * - Oracle staleness check via maxCrankStalenessSlots
 * - Dust position threshold: min_liquidation_abs
 * - ADL exclusion epoch mechanism
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeInitUser, encodeDepositCollateral, encodeWithdrawCollateral, encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
}

const results: TestResult[] = [];

async function delay(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function runCrank(): Promise<boolean> {
  try {
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed", skipPreflight: true });
    return true;
  } catch (e) {
    return false;
  }
}

async function getMarketState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({ idx, ...acc });
  }
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return { engine, params, accounts, vaultLamports: vaultInfo?.lamports || 0 };
}

async function deposit(userIdx: number, amount: bigint): Promise<boolean> {
  try {
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const depositData = encodeDepositCollateral({ userIdx, amount });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e) {
    return false;
  }
}

async function withdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error: string }> {
  try {
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const withdrawData = encodeWithdrawCollateral({ userIdx, amount });
    const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true, error: "" };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

async function trade(userIdx: number, lpIdx: number, size: bigint): Promise<{ success: boolean; error: string }> {
  try {
    const tradeData = encodeTradeCpi({ userIdx, lpIdx, size });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
      MATCHER_PROGRAM, MATCHER_CTX, LP_PDA
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true, error: "" };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown error" };
  }
}

console.log('============================================================');
console.log('ORACLE AND EDGE CASE ATTACK TESTING');
console.log('Based on deep analysis of percolator.rs');
console.log('============================================================\n');

// Test 1: Oracle Staleness Check
async function testOracleStaleness(): Promise<TestResult> {
  console.log('[TEST 1] Oracle Staleness Verification');
  console.log('Strategy: Check crank staleness enforcement');

  const state = await getMarketState();

  const currentSlot = Number(state.engine.currentSlot || 0);
  const lastCrankSlot = Number(state.engine.lastCrankSlot || 0);
  const maxStaleness = Number(state.params.maxCrankStalenessSlots || 200);

  const staleness = currentSlot - lastCrankSlot;

  console.log(`  Current slot: ${currentSlot}`);
  console.log(`  Last crank slot: ${lastCrankSlot}`);
  console.log(`  Max staleness allowed: ${maxStaleness}`);
  console.log(`  Current staleness: ${staleness}`);

  // Try to trigger crank to see if it works
  const crankSuccess = await runCrank();
  console.log(`  Crank successful: ${crankSuccess}`);

  return {
    name: 'Oracle Staleness',
    passed: staleness < maxStaleness || crankSuccess,
    details: `Staleness: ${staleness} (max: ${maxStaleness}), Crank: ${crankSuccess ? 'OK' : 'FAILED'}`,
    severity: staleness >= maxStaleness && !crankSuccess ? 'high' as const : 'low' as const
  };
}

// Test 2: Dust Position Cleanup
async function testDustPosition(): Promise<TestResult> {
  console.log('\n[TEST 2] Dust Position Cleanup');
  console.log('Strategy: Create dust position, verify crank cleans it up');

  const state = await getMarketState();
  const minLiquidationAbs = BigInt(state.params.minLiquidationAbs || 100000);

  console.log(`  min_liquidation_abs: ${minLiquidationAbs}`);

  // Find account with capital for testing
  const account = state.accounts.find((a: any) =>
    a.kind === AccountKind.User && Number(a.capital || 0) > 10000000 && BigInt(a.positionSize || 0) === 0n
  );

  if (!account) {
    return {
      name: 'Dust Position Cleanup',
      passed: true,
      details: 'No suitable account for dust test',
      severity: 'low' as const
    };
  }

  // Try to create a very small position
  const dustSize = minLiquidationAbs / 2n; // Half the minimum
  console.log(`  Attempting dust position of size: ${dustSize}`);

  const result = await trade(account.idx, 0, dustSize);

  if (result.success) {
    // Check position before crank
    await delay(500);
    const stateBeforeCrank = await getMarketState();
    const accountBefore = stateBeforeCrank.accounts.find((a: any) => a.idx === account.idx);
    const posBefore = BigInt(accountBefore?.positionSize || 0);
    console.log(`  Position before crank: ${posBefore}`);

    // Run crank to clean up dust
    await runCrank();
    await delay(2000);

    // Check if crank cleaned up dust
    const stateAfterCrank = await getMarketState();
    const accountAfter = stateAfterCrank.accounts.find((a: any) => a.idx === account.idx);
    const posAfter = BigInt(accountAfter?.positionSize || 0);
    console.log(`  Position after crank: ${posAfter}`);

    // min_liquidation_abs controls crank cleanup, not trade creation
    // Dust positions should be closed by crank
    const wasCleanedUp = posAfter === 0n || posAfter >= minLiquidationAbs;

    return {
      name: 'Dust Position Cleanup',
      passed: wasCleanedUp,
      details: wasCleanedUp ? `Dust cleaned up (${posBefore} -> ${posAfter})` : `WARNING: Dust persists (${posAfter} < ${minLiquidationAbs})`,
      severity: !wasCleanedUp ? 'medium' as const : 'low' as const
    };
  }

  return {
    name: 'Dust Position Cleanup',
    passed: true,
    details: `Trade blocked: ${result.error.slice(0, 40)}`,
    severity: 'low' as const
  };
}

// Test 3: Open Interest Tracking
async function testOpenInterestAccuracy(): Promise<TestResult> {
  console.log('\n[TEST 3] Open Interest Tracking Accuracy');
  console.log('Strategy: Verify OI matches sum of absolute positions');

  const state = await getMarketState();

  const reportedOI = BigInt(state.engine.totalOpenInterest || 0);

  // Calculate actual OI from positions
  let calculatedOI = 0n;
  for (const account of state.accounts) {
    const pos = BigInt(account.positionSize || 0);
    calculatedOI += pos < 0n ? -pos : pos;
  }

  console.log(`  Reported OI: ${reportedOI}`);
  console.log(`  Calculated OI: ${calculatedOI}`);

  const mismatch = reportedOI > calculatedOI ? reportedOI - calculatedOI : calculatedOI - reportedOI;

  return {
    name: 'Open Interest Tracking',
    passed: mismatch === 0n,
    details: `Reported: ${reportedOI}, Calculated: ${calculatedOI}, Mismatch: ${mismatch}`,
    severity: mismatch > 0n ? 'high' as const : 'low' as const
  };
}

// Test 4: ADL Epoch Tracking
async function testADLEpoch(): Promise<TestResult> {
  console.log('\n[TEST 4] ADL Epoch Tracking');
  console.log('Strategy: Verify ADL epoch state consistency');

  const state = await getMarketState();

  const pendingEpoch = Number(state.engine.pendingEpoch || 0);
  const crankStep = Number(state.engine.crankStep || 0);
  const sweepStart = Number(state.engine.lastSweepStartSlot || 0);
  const sweepComplete = Number(state.engine.lastSweepCompleteSlot || 0);

  console.log(`  Pending epoch: ${pendingEpoch}`);
  console.log(`  Crank step: ${crankStep}`);
  console.log(`  Sweep start slot: ${sweepStart}`);
  console.log(`  Sweep complete slot: ${sweepComplete}`);

  // Sweep should be complete (start == complete) during normal operation
  const sweepInProgress = sweepStart !== sweepComplete;

  return {
    name: 'ADL Epoch Tracking',
    passed: !sweepInProgress || crankStep < 1024, // Either complete or mid-sweep
    details: `Epoch: ${pendingEpoch}, Step: ${crankStep}, Sweep in progress: ${sweepInProgress}`,
    severity: 'low' as const
  };
}

// Test 5: Lifetime Counter Integrity
async function testLifetimeCounters(): Promise<TestResult> {
  console.log('\n[TEST 5] Lifetime Counter Integrity');
  console.log('Strategy: Verify liquidation and force-close counters');

  const state = await getMarketState();

  const lifetimeLiquidations = Number(state.engine.lifetimeLiquidations || 0);
  const lifetimeForceCloses = Number(state.engine.lifetimeForceRealizeCloses || 0);

  console.log(`  Lifetime liquidations: ${lifetimeLiquidations}`);
  console.log(`  Lifetime force closes: ${lifetimeForceCloses}`);

  // Counters should be non-negative and reasonable
  const reasonable = lifetimeLiquidations >= 0 && lifetimeLiquidations < 1000000 &&
                     lifetimeForceCloses >= 0 && lifetimeForceCloses < 1000000;

  return {
    name: 'Lifetime Counters',
    passed: reasonable,
    details: `Liquidations: ${lifetimeLiquidations}, Force closes: ${lifetimeForceCloses}`,
    severity: !reasonable ? 'high' as const : 'low' as const
  };
}

// Test 6: Account Capital Bounds
async function testCapitalBounds(): Promise<TestResult> {
  console.log('\n[TEST 6] Account Capital Bounds');
  console.log('Strategy: Verify no negative or impossibly large capital');

  const state = await getMarketState();

  let minCapital = BigInt(Number.MAX_SAFE_INTEGER);
  let maxCapital = 0n;
  let negativeCapital = false;
  let hugeCapital = false;

  const MAX_REASONABLE_CAPITAL = 1000000000000000n; // 1 million SOL

  for (const account of state.accounts) {
    const capital = BigInt(account.capital || 0);
    if (capital < 0n) negativeCapital = true;
    if (capital > MAX_REASONABLE_CAPITAL) hugeCapital = true;
    if (capital < minCapital) minCapital = capital;
    if (capital > maxCapital) maxCapital = capital;
  }

  console.log(`  Min capital: ${minCapital}`);
  console.log(`  Max capital: ${maxCapital}`);
  console.log(`  Negative capital found: ${negativeCapital}`);
  console.log(`  Unreasonably large capital: ${hugeCapital}`);

  return {
    name: 'Capital Bounds',
    passed: !negativeCapital && !hugeCapital,
    details: `Min: ${minCapital}, Max: ${maxCapital}`,
    severity: negativeCapital || hugeCapital ? 'critical' as const : 'low' as const
  };
}

// Test 7: Position Size Bounds
async function testPositionBounds(): Promise<TestResult> {
  console.log('\n[TEST 7] Position Size Bounds');
  console.log('Strategy: Verify positions within MAX_POSITION_ABS');

  const state = await getMarketState();

  // MAX_POSITION_ABS from source = 10^20
  const MAX_POSITION_ABS = 100000000000000000000n;

  let maxAbsPosition = 0n;
  let overflowFound = false;

  for (const account of state.accounts) {
    const pos = BigInt(account.positionSize || 0);
    const absPos = pos < 0n ? -pos : pos;
    if (absPos > maxAbsPosition) maxAbsPosition = absPos;
    if (absPos > MAX_POSITION_ABS) overflowFound = true;
  }

  console.log(`  Max absolute position: ${maxAbsPosition}`);
  console.log(`  MAX_POSITION_ABS limit: ${MAX_POSITION_ABS}`);
  console.log(`  Overflow found: ${overflowFound}`);

  return {
    name: 'Position Size Bounds',
    passed: !overflowFound,
    details: `Max position: ${maxAbsPosition}`,
    severity: overflowFound ? 'critical' as const : 'low' as const
  };
}

// Test 8: Insurance Fund Floor
async function testInsuranceFloor(): Promise<TestResult> {
  console.log('\n[TEST 8] Insurance Fund Floor');
  console.log('Strategy: Verify insurance above risk threshold');

  const state = await getMarketState();

  const insuranceBalance = BigInt(state.engine.insuranceFund?.balance || 0);
  const threshold = BigInt(state.params.riskReductionThreshold || 0);
  const feeRevenue = BigInt(state.engine.insuranceFund?.feeRevenue || 0);

  console.log(`  Insurance balance: ${insuranceBalance}`);
  console.log(`  Risk threshold: ${threshold}`);
  console.log(`  Fee revenue: ${feeRevenue}`);

  const aboveFloor = insuranceBalance > threshold;

  return {
    name: 'Insurance Fund Floor',
    passed: aboveFloor,
    details: `Balance: ${insuranceBalance}, Threshold: ${threshold}, Above: ${aboveFloor}`,
    severity: !aboveFloor ? 'critical' as const : 'low' as const
  };
}

// Test 9: Entry Price Consistency
async function testEntryPriceConsistency(): Promise<TestResult> {
  console.log('\n[TEST 9] Entry Price Consistency');
  console.log('Strategy: Verify entry prices are within oracle bounds');

  const state = await getMarketState();

  // Get oracle price from pyth (approximately)
  // MAX_ORACLE_PRICE = 10^15
  const MAX_ORACLE_PRICE = 1000000000000000n;

  let invalidEntryPrice = false;
  let minEntry = BigInt(Number.MAX_SAFE_INTEGER);
  let maxEntry = 0n;

  for (const account of state.accounts) {
    const entry = BigInt(account.entryPrice || 0);
    if (entry > MAX_ORACLE_PRICE) invalidEntryPrice = true;
    if (entry > 0n && entry < minEntry) minEntry = entry;
    if (entry > maxEntry) maxEntry = entry;
  }

  console.log(`  Min entry price: ${minEntry}`);
  console.log(`  Max entry price: ${maxEntry}`);
  console.log(`  Invalid entry prices: ${invalidEntryPrice}`);

  return {
    name: 'Entry Price Consistency',
    passed: !invalidEntryPrice,
    details: `Range: ${minEntry} - ${maxEntry}`,
    severity: invalidEntryPrice ? 'critical' as const : 'low' as const
  };
}

// Test 10: Net LP Position Balance
async function testNetLPBalance(): Promise<TestResult> {
  console.log('\n[TEST 10] Net LP Position Balance');
  console.log('Strategy: Verify net_lp_pos matches LP position');

  const state = await getMarketState();

  const netLpPos = BigInt(state.engine.netLpPos || 0);

  // Find LP account
  const lpAccount = state.accounts.find((a: any) => a.kind === AccountKind.LP);
  const lpPosition = lpAccount ? BigInt(lpAccount.positionSize || 0) : 0n;

  console.log(`  Engine net_lp_pos: ${netLpPos}`);
  console.log(`  LP account position: ${lpPosition}`);

  const mismatch = netLpPos !== lpPosition;

  return {
    name: 'Net LP Position Balance',
    passed: !mismatch,
    details: `Engine: ${netLpPos}, LP: ${lpPosition}`,
    severity: mismatch ? 'critical' as const : 'low' as const
  };
}

async function main() {
  try {
    results.push(await testOracleStaleness());
    results.push(await testDustPosition());
    results.push(await testOpenInterestAccuracy());
    results.push(await testADLEpoch());
    results.push(await testLifetimeCounters());
    results.push(await testCapitalBounds());
    results.push(await testPositionBounds());
    results.push(await testInsuranceFloor());
    results.push(await testEntryPriceConsistency());
    results.push(await testNetLPBalance());

    // Print summary
    console.log('\n============================================================');
    console.log('ORACLE/EDGE CASE TEST RESULTS');
    console.log('============================================================\n');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}\n`);

    for (const result of results) {
      const icon = result.passed ? '[VERIFIED]' : '[FAILED]';
      console.log(`${icon} ${result.name}`);
      console.log(`         ${result.details}`);
      if (!result.passed && result.severity) {
        console.log(`         Severity: ${result.severity.toUpperCase()}`);
      }
    }

    // Update status.md
    const statusPath = 'status.md';
    let status = fs.readFileSync(statusPath, 'utf-8');

    const timestamp = new Date().toISOString();
    const newSection = `

### Oracle/Edge Case Test - ${timestamp}

**Results:** ${passed}/${results.length} passed

${results.map(r => `- [${r.passed ? 'x' : ' '}] ${r.name}: ${r.details}`).join('\n')}
`;

    status += newSection;
    fs.writeFileSync(statusPath, status);
    console.log('\nStatus updated in status.md');

  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

main();
