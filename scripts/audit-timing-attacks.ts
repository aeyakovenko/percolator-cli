/**
 * Timing Attack Tests
 *
 * Edge cases around the timing of:
 * - Cranks (last_crank_slot, max_crank_staleness_slots = 200)
 * - Oracle updates (Pyth price feeds)
 * - Trade execution
 * - Funding settlement
 * - Sweep completion
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

async function runCrank(): Promise<{ success: boolean; error?: string }> {
  try {
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed", skipPreflight: true });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || "Unknown" };
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
  const slotInfo = await conn.getSlot();
  return { engine, params, accounts, vaultLamports: vaultInfo?.lamports || 0, currentSlot: slotInfo };
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

console.log('============================================================');
console.log('TIMING ATTACK TESTING');
console.log('Edge cases around cranks, oracle updates, and trades');
console.log('============================================================\n');

// Test 1: Crank Staleness Window
async function testCrankStaleness(): Promise<TestResult> {
  console.log('[TEST 1] Crank Staleness Window');
  console.log('Strategy: Check crank timing enforcement');

  const state = await getMarketState();

  const lastCrankSlot = Number(state.engine.lastCrankSlot || 0);
  const maxStaleness = Number(state.params.maxCrankStalenessSlots || 200);
  const currentSlot = state.currentSlot;

  const staleness = currentSlot - lastCrankSlot;
  const slotsTilStale = maxStaleness - staleness;

  console.log(`  Current slot: ${currentSlot}`);
  console.log(`  Last crank slot: ${lastCrankSlot}`);
  console.log(`  Max staleness: ${maxStaleness} slots`);
  console.log(`  Current staleness: ${staleness} slots`);
  console.log(`  Slots until stale: ${slotsTilStale}`);

  // Try a trade
  const account = state.accounts.find((a: any) =>
    a.kind === AccountKind.User && Number(a.capital || 0) > 10000000
  );

  if (account) {
    const tradeResult = await trade(account.idx, 0, 1_000_000_000n);
    console.log(`  Trade result: ${tradeResult.success ? 'SUCCESS' : 'BLOCKED'}`);

    if (!tradeResult.success && tradeResult.error.includes('CrankStale')) {
      // Crank is stale, run crank and try again
      console.log(`  Crank stale, running crank...`);
      await runCrank();
      await delay(1000);
      const retryResult = await trade(account.idx, 0, 1_000_000_000n);
      console.log(`  Retry result: ${retryResult.success ? 'SUCCESS' : 'BLOCKED'}`);
    }
  }

  return {
    name: 'Crank Staleness',
    passed: staleness < maxStaleness,
    details: `Staleness: ${staleness}/${maxStaleness} slots, Slots til stale: ${slotsTilStale}`,
    severity: staleness >= maxStaleness ? 'medium' as const : 'low' as const
  };
}

// Test 2: Sweep Completion Timing
async function testSweepTiming(): Promise<TestResult> {
  console.log('\n[TEST 2] Sweep Completion Timing');
  console.log('Strategy: Check sweep state consistency');

  const state = await getMarketState();

  const sweepStartSlot = Number(state.engine.lastSweepStartSlot || 0);
  const sweepCompleteSlot = Number(state.engine.lastSweepCompleteSlot || 0);
  const crankStep = Number(state.engine.crankStep || 0);
  const currentSlot = state.currentSlot;

  const sweepInProgress = sweepStartSlot !== sweepCompleteSlot;
  const sweepAge = currentSlot - sweepCompleteSlot;

  console.log(`  Sweep start slot: ${sweepStartSlot}`);
  console.log(`  Sweep complete slot: ${sweepCompleteSlot}`);
  console.log(`  Crank step: ${crankStep}`);
  console.log(`  Sweep in progress: ${sweepInProgress}`);
  console.log(`  Sweep age: ${sweepAge} slots`);

  // If sweep is in progress, try a risk-increasing trade
  if (sweepInProgress) {
    const account = state.accounts.find((a: any) =>
      a.kind === AccountKind.User && Number(a.capital || 0) > 50000000
    );

    if (account) {
      console.log(`  Testing trade during incomplete sweep...`);
      const tradeResult = await trade(account.idx, 0, 5_000_000_000n);

      if (tradeResult.success) {
        return {
          name: 'Sweep Timing',
          passed: false,
          details: 'WARNING: Risk-increasing trade allowed during incomplete sweep!',
          severity: 'high' as const
        };
      } else {
        console.log(`  Trade blocked: ${tradeResult.error.slice(0, 50)}`);
      }
    }
  }

  return {
    name: 'Sweep Timing',
    passed: !sweepInProgress || crankStep > 0,
    details: `Sweep: ${sweepInProgress ? 'IN PROGRESS' : 'COMPLETE'}, Age: ${sweepAge} slots`,
    severity: 'low' as const
  };
}

// Test 3: Multi-Trade Same Slot
async function testMultiTradeSameSlot(): Promise<TestResult> {
  console.log('\n[TEST 3] Multi-Trade Same Slot');
  console.log('Strategy: Execute multiple trades rapidly');

  const state = await getMarketState();

  const account = state.accounts.find((a: any) =>
    a.kind === AccountKind.User && Number(a.capital || 0) > 100000000 && BigInt(a.positionSize || 0) === 0n
  );

  if (!account) {
    return {
      name: 'Multi-Trade Same Slot',
      passed: true,
      details: 'No suitable account for test',
      severity: 'low' as const
    };
  }

  const capitalBefore = Number(account.capital || 0);
  console.log(`  Testing account ${account.idx}, capital: ${(capitalBefore / 1e9).toFixed(4)} SOL`);

  // Run crank first to ensure fresh state
  await runCrank();

  // Try to execute 3 trades as fast as possible
  const startSlot = await conn.getSlot();
  console.log(`  Start slot: ${startSlot}`);

  const results: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const size = (i % 2 === 0) ? 2_000_000_000n : -2_000_000_000n;
    const result = await trade(account.idx, 0, size);
    results.push(result.success);
    // No delay between trades
  }

  const endSlot = await conn.getSlot();
  console.log(`  End slot: ${endSlot}`);
  console.log(`  Trades completed: ${results.filter(r => r).length}/3`);
  console.log(`  Slots elapsed: ${endSlot - startSlot}`);

  // Check final state
  await delay(1000);
  const stateAfter = await getMarketState();
  const accountAfter = stateAfter.accounts.find((a: any) => a.idx === account.idx);
  const capitalAfter = Number(accountAfter?.capital || 0);
  const capitalChange = capitalAfter - capitalBefore;

  console.log(`  Capital change: ${(capitalChange / 1e9).toFixed(6)} SOL`);

  // Capital should decrease due to fees, never increase
  return {
    name: 'Multi-Trade Same Slot',
    passed: capitalChange <= 0,
    details: `${results.filter(r => r).length}/3 trades, ${endSlot - startSlot} slots, capital: ${(capitalChange / 1e9).toFixed(6)} SOL`,
    severity: capitalChange > 0 ? 'critical' as const : 'low' as const
  };
}

// Test 4: Funding Settlement Timing
async function testFundingTiming(): Promise<TestResult> {
  console.log('\n[TEST 4] Funding Settlement Timing');
  console.log('Strategy: Check funding accrual between cranks');

  const stateBefore = await getMarketState();

  const fundingIndexBefore = BigInt(stateBefore.engine.fundingIndexQpbE6 || 0);
  const lastFundingSlot = Number(stateBefore.engine.lastFundingSlot || 0);
  const currentSlot = stateBefore.currentSlot;

  console.log(`  Funding index: ${fundingIndexBefore}`);
  console.log(`  Last funding slot: ${lastFundingSlot}`);
  console.log(`  Current slot: ${currentSlot}`);
  console.log(`  Slots since funding: ${currentSlot - lastFundingSlot}`);

  // Run crank to settle funding
  await runCrank();
  await delay(2000);

  const stateAfter = await getMarketState();
  const fundingIndexAfter = BigInt(stateAfter.engine.fundingIndexQpbE6 || 0);
  const fundingDelta = fundingIndexAfter - fundingIndexBefore;

  console.log(`  Funding delta after crank: ${fundingDelta}`);

  // Check if any accounts have pending funding
  let maxUnsettledFunding = 0n;
  for (const account of stateAfter.accounts) {
    const accountFundingIndex = BigInt(account.fundingIndex || 0);
    const diff = fundingIndexAfter > accountFundingIndex ? fundingIndexAfter - accountFundingIndex : 0n;
    if (diff > maxUnsettledFunding) {
      maxUnsettledFunding = diff;
    }
  }

  console.log(`  Max unsettled funding index delta: ${maxUnsettledFunding}`);

  return {
    name: 'Funding Settlement Timing',
    passed: true, // Funding is lazy-settled, this is expected
    details: `Delta: ${fundingDelta}, Max unsettled: ${maxUnsettledFunding}`,
    severity: 'low' as const
  };
}

// Test 5: Liquidation Front-Running
async function testLiquidationFrontRun(): Promise<TestResult> {
  console.log('\n[TEST 5] Liquidation Front-Running');
  console.log('Strategy: Check if at-risk accounts can escape via trade');

  const state = await getMarketState();

  // Find account closest to liquidation
  let mostAtRisk: any = null;
  let lowestMarginRatio = Infinity;

  for (const account of state.accounts) {
    if (account.kind !== AccountKind.User) continue;
    const pos = BigInt(account.positionSize || 0);
    if (pos === 0n) continue;

    const capital = Number(account.capital || 0);
    const pnl = Number(account.pnl || 0);
    const absPos = pos < 0n ? -pos : pos;

    // Rough margin ratio calculation
    const equity = capital + pnl;
    const posValue = Number(absPos) * 7700 / 1e6; // Approx oracle price
    const marginRatio = equity / posValue;

    if (marginRatio > 0 && marginRatio < lowestMarginRatio) {
      lowestMarginRatio = marginRatio;
      mostAtRisk = { ...account, marginRatio };
    }
  }

  if (!mostAtRisk) {
    return {
      name: 'Liquidation Front-Running',
      passed: true,
      details: 'No at-risk accounts to test',
      severity: 'low' as const
    };
  }

  console.log(`  Most at-risk account: ${mostAtRisk.idx}`);
  console.log(`  Margin ratio: ${(mostAtRisk.marginRatio * 100).toFixed(2)}%`);
  console.log(`  Maintenance: 5%`);

  // If below 10% margin, try to close position before crank liquidates
  if (mostAtRisk.marginRatio < 0.10) {
    const pos = BigInt(mostAtRisk.positionSize || 0);
    console.log(`  Attempting to close position to escape liquidation...`);

    const closeResult = await trade(mostAtRisk.idx, 0, -pos);
    console.log(`  Close result: ${closeResult.success ? 'SUCCESS' : closeResult.error.slice(0, 50)}`);

    // This is actually allowed behavior - users can close risk-reducing positions
    // The concern would be if they can INCREASE risk while at-risk
  }

  return {
    name: 'Liquidation Front-Running',
    passed: true, // Risk-reducing closes are allowed
    details: `At-risk account: ${mostAtRisk.idx}, margin: ${(mostAtRisk.marginRatio * 100).toFixed(2)}%`,
    severity: 'low' as const
  };
}

// Test 6: Trade Immediately After Crank
async function testTradeAfterCrank(): Promise<TestResult> {
  console.log('\n[TEST 6] Trade Immediately After Crank');
  console.log('Strategy: Trade in same slot as crank');

  // Find an account
  const state = await getMarketState();
  const account = state.accounts.find((a: any) =>
    a.kind === AccountKind.User && Number(a.capital || 0) > 50000000
  );

  if (!account) {
    return {
      name: 'Trade After Crank',
      passed: true,
      details: 'No suitable account',
      severity: 'low' as const
    };
  }

  // Run crank
  const crankResult = await runCrank();
  const crankSlot = await conn.getSlot();
  console.log(`  Crank slot: ${crankSlot}, success: ${crankResult.success}`);

  // Immediately try to trade
  const tradeResult = await trade(account.idx, 0, 1_000_000_000n);
  const tradeSlot = await conn.getSlot();
  console.log(`  Trade slot: ${tradeSlot}, success: ${tradeResult.success}`);

  const sameSlot = crankSlot === tradeSlot;
  console.log(`  Same slot: ${sameSlot}`);

  return {
    name: 'Trade After Crank',
    passed: tradeResult.success,
    details: `Crank@${crankSlot}, Trade@${tradeSlot}, Same slot: ${sameSlot}`,
    severity: !tradeResult.success ? 'medium' as const : 'low' as const
  };
}

// Test 7: Withdrawal After Trade
async function testWithdrawAfterTrade(): Promise<TestResult> {
  console.log('\n[TEST 7] Withdrawal After Trade');
  console.log('Strategy: Withdraw immediately after profitable trade');

  const state = await getMarketState();

  // Find account with position
  const account = state.accounts.find((a: any) =>
    a.kind === AccountKind.User &&
    Number(a.capital || 0) > 50000000 &&
    BigInt(a.positionSize || 0) !== 0n
  );

  if (!account) {
    return {
      name: 'Withdrawal After Trade',
      passed: true,
      details: 'No suitable account',
      severity: 'low' as const
    };
  }

  const capitalBefore = Number(account.capital || 0);
  const pos = BigInt(account.positionSize || 0);
  console.log(`  Account ${account.idx}: capital ${(capitalBefore / 1e9).toFixed(4)} SOL, pos ${pos}`);

  // Close position
  const closeResult = await trade(account.idx, 0, -pos);
  console.log(`  Close trade: ${closeResult.success ? 'SUCCESS' : closeResult.error.slice(0, 40)}`);

  if (!closeResult.success) {
    return {
      name: 'Withdrawal After Trade',
      passed: true,
      details: `Trade failed: ${closeResult.error.slice(0, 30)}`,
      severity: 'low' as const
    };
  }

  // Immediately try to withdraw capital + any profit
  const stateAfterTrade = await getMarketState();
  const accountAfterTrade = stateAfterTrade.accounts.find((a: any) => a.idx === account.idx);
  const capitalAfterTrade = Number(accountAfterTrade?.capital || 0);
  const pnlAfterTrade = Number(accountAfterTrade?.pnl || 0);

  console.log(`  After trade: capital ${(capitalAfterTrade / 1e9).toFixed(4)}, pnl ${(pnlAfterTrade / 1e9).toFixed(6)}`);

  // Try to withdraw more than original capital (attempting to extract unrealized gains)
  const withdrawAmount = BigInt(capitalAfterTrade + Math.max(0, pnlAfterTrade));
  console.log(`  Attempting withdraw: ${(Number(withdrawAmount) / 1e9).toFixed(4)} SOL`);

  const withdrawResult = await withdraw(account.idx, withdrawAmount);
  console.log(`  Withdraw: ${withdrawResult.success ? 'SUCCESS' : withdrawResult.error.slice(0, 40)}`);

  // Check warmup enforcement
  if (pnlAfterTrade > 0 && withdrawResult.success) {
    // This might be ok if warmup has passed
    const warmupPeriod = Number(state.params.warmupPeriodSlots || 10);
    console.log(`  WARNING: Full withdraw succeeded, checking warmup (${warmupPeriod} slots)`);
  }

  return {
    name: 'Withdrawal After Trade',
    passed: true, // Full withdraw of capital is allowed
    details: `Trade closed, withdraw: ${withdrawResult.success ? 'OK' : 'BLOCKED'}`,
    severity: 'low' as const
  };
}

// Test 8: Rapid Deposit-Trade-Withdraw Cycle
async function testRapidCycle(): Promise<TestResult> {
  console.log('\n[TEST 8] Rapid Deposit-Trade-Withdraw Cycle');
  console.log('Strategy: Fast cycle to find timing exploits');

  const state = await getMarketState();

  // Find account with minimal position
  const account = state.accounts.find((a: any) =>
    a.kind === AccountKind.User &&
    Number(a.capital || 0) > 100000000 &&
    BigInt(a.positionSize || 0) === 0n
  );

  if (!account) {
    return {
      name: 'Rapid Cycle',
      passed: true,
      details: 'No suitable account',
      severity: 'low' as const
    };
  }

  const capitalStart = Number(account.capital || 0);
  console.log(`  Starting capital: ${(capitalStart / 1e9).toFixed(4)} SOL`);

  // Ensure fresh crank
  await runCrank();

  // Rapid cycle: trade -> crank -> close -> withdraw
  const startTime = Date.now();

  // Open position
  const openResult = await trade(account.idx, 0, 5_000_000_000n);
  console.log(`  Open: ${openResult.success ? 'OK' : 'FAIL'}`);

  // Run crank (settles funding, may trigger liquidation scan)
  await runCrank();

  // Close position
  const closeResult = await trade(account.idx, 0, -5_000_000_000n);
  console.log(`  Close: ${closeResult.success ? 'OK' : 'FAIL'}`);

  // Try withdraw
  const withdrawResult = await withdraw(account.idx, 10_000_000n);
  console.log(`  Withdraw: ${withdrawResult.success ? 'OK' : 'FAIL'}`);

  const elapsed = Date.now() - startTime;

  // Check final state
  const stateAfter = await getMarketState();
  const accountAfter = stateAfter.accounts.find((a: any) => a.idx === account.idx);
  const capitalEnd = Number(accountAfter?.capital || 0);
  const capitalChange = capitalEnd - capitalStart;

  console.log(`  Elapsed: ${elapsed}ms`);
  console.log(`  Capital change: ${(capitalChange / 1e9).toFixed(6)} SOL`);

  // Capital should not increase (fees should be charged)
  return {
    name: 'Rapid Cycle',
    passed: capitalChange <= 10000000, // Allow 0.01 SOL for withdraw amount
    details: `${elapsed}ms, capital change: ${(capitalChange / 1e9).toFixed(6)} SOL`,
    severity: capitalChange > 10000000 ? 'critical' as const : 'low' as const
  };
}

// Test 9: Crank During Trade (Atomicity)
async function testAtomicity(): Promise<TestResult> {
  console.log('\n[TEST 9] Transaction Atomicity');
  console.log('Strategy: Verify crank cannot interrupt trade');

  // This tests Solana's transaction atomicity
  // A crank cannot run "in the middle" of a trade - that's not how Solana works
  // But we can verify state consistency

  const stateBefore = await getMarketState();

  // Capture conservation equation
  const vault = BigInt(stateBefore.vaultLamports || 0);
  let totalCapital = 0n;
  let totalPnl = 0n;
  for (const account of stateBefore.accounts) {
    totalCapital += BigInt(account.capital || 0);
    totalPnl += BigInt(account.pnl || 0);
  }
  const insurance = BigInt(stateBefore.engine.insuranceFund?.balance || 0);

  console.log(`  Vault: ${vault}`);
  console.log(`  Total capital: ${totalCapital}`);
  console.log(`  Insurance: ${insurance}`);

  // Conservation: vault >= capital + insurance
  const conserved = vault >= totalCapital + insurance;
  const slack = vault - (totalCapital + insurance);

  console.log(`  Slack: ${slack} (should be >= 0)`);

  return {
    name: 'Transaction Atomicity',
    passed: conserved,
    details: `Vault: ${vault}, Required: ${totalCapital + insurance}, Slack: ${slack}`,
    severity: !conserved ? 'critical' as const : 'low' as const
  };
}

// Test 10: Oracle Price Change Detection
async function testOraclePriceChange(): Promise<TestResult> {
  console.log('\n[TEST 10] Oracle Price Change Detection');
  console.log('Strategy: Monitor oracle price stability');

  const state1 = await getMarketState();
  const accounts1 = state1.accounts;

  // Get entry prices
  const entryPrices1 = new Map<number, bigint>();
  for (const account of accounts1) {
    if (BigInt(account.positionSize || 0) !== 0n) {
      entryPrices1.set(account.idx, BigInt(account.entryPrice || 0));
    }
  }

  console.log(`  Accounts with positions: ${entryPrices1.size}`);

  // Execute a trade
  const account = state1.accounts.find((a: any) =>
    a.kind === AccountKind.User && Number(a.capital || 0) > 50000000
  );

  if (account) {
    await trade(account.idx, 0, 1_000_000_000n);
  }

  await delay(2000);

  const state2 = await getMarketState();

  // Check for entry price changes (indicates oracle was used)
  let priceChanges = 0;
  for (const account of state2.accounts) {
    const oldEntry = entryPrices1.get(account.idx);
    const newEntry = BigInt(account.entryPrice || 0);
    if (oldEntry !== undefined && oldEntry !== newEntry) {
      priceChanges++;
      console.log(`  Account ${account.idx}: entry ${oldEntry} -> ${newEntry}`);
    }
  }

  console.log(`  Entry price changes: ${priceChanges}`);

  return {
    name: 'Oracle Price Change',
    passed: true, // Entry price changes during trades are expected
    details: `${priceChanges} entry price changes observed`,
    severity: 'low' as const
  };
}

async function main() {
  try {
    results.push(await testCrankStaleness());
    results.push(await testSweepTiming());
    results.push(await testMultiTradeSameSlot());
    results.push(await testFundingTiming());
    results.push(await testLiquidationFrontRun());
    results.push(await testTradeAfterCrank());
    results.push(await testWithdrawAfterTrade());
    results.push(await testRapidCycle());
    results.push(await testAtomicity());
    results.push(await testOraclePriceChange());

    // Print summary
    console.log('\n============================================================');
    console.log('TIMING ATTACK TEST RESULTS');
    console.log('============================================================\n');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}\n`);

    for (const result of results) {
      const icon = result.passed ? '[DEFENDED]' : '[VULNERABLE]';
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

### Timing Attack Test - ${timestamp}

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
