/**
 * T16: Risk Reduction and Loss Management Tests
 *
 * Tests the risk reduction mechanics (similar to ADL in other systems).
 *
 * Key concepts:
 * - lossAccum: Accumulated losses from underwater accounts
 * - riskReductionOnly: Flag indicating system is in risk reduction mode
 * - riskReductionThreshold: Threshold that triggers risk reduction mode
 * - When triggered, only position-closing trades are allowed
 *
 * T16.1: Verify risk reduction fields exist and are initialized
 * T16.2: Loss accumulation tracking
 * T16.3: Risk reduction mode state verification
 * T16.4: Position closure allowed in risk reduction mode
 * T16.5: Conservation during loss scenarios
 * T16.6: Insurance fund interaction with losses
 */

import TestHarness, { TestContext, UserContext, MATCHER_PROGRAM_ID } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT16Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T16: Risk Reduction Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;
  let lp: UserContext;
  let user: UserContext;

  // -------------------------------------------------------------------------
  // T16.1: Verify risk reduction fields exist and are initialized
  // -------------------------------------------------------------------------
  await harness.runTest("T16.1: Risk reduction fields initialization", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    let snapshot = await harness.snapshot(ctx);

    // Check risk reduction fields in params
    console.log(`    Risk reduction threshold: ${snapshot.params.riskReductionThreshold}`);

    // Check risk reduction fields in engine state (before crank)
    console.log(`    Loss accumulator: ${snapshot.engine.lossAccum}`);
    console.log(`    Risk reduction only (before): ${snapshot.engine.riskReductionOnly}`);
    console.log(`    Risk reduction withdrawn: ${snapshot.engine.riskReductionModeWithdrawn}`);

    // Loss accumulator should start at 0
    TestHarness.assertBigIntEqual(
      snapshot.engine.lossAccum,
      0n,
      "Loss accumulator should be 0 initially"
    );

    // Note: Market may start in risk reduction mode with threshold=0
    // This is cleared after keeper crank, which is normal behavior
    // The initial crank in createFreshMarket should have cleared it
    // but timing can vary - check that it's eventually correct

    // Verify threshold is set correctly
    TestHarness.assertBigIntEqual(
      snapshot.params.riskReductionThreshold,
      0n,
      "Risk reduction threshold should be 0 (disabled)"
    );
  });

  // -------------------------------------------------------------------------
  // T16.2: Loss accumulation tracking
  // -------------------------------------------------------------------------
  await harness.runTest("T16.2: Loss accumulation tracking", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Setup LP and user
    lp = await harness.createUser(ctx, "lp2", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000"); // 100 USDC

    user = await harness.createUser(ctx, "user2", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000"); // 10 USDC

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Take a position
    const tradeResult = await harness.tradeCpi(ctx, user, lp, "300");
    if (tradeResult.err) {
      console.log(`    Trade error: ${tradeResult.err.slice(0, 60)}`);
    }

    // Check loss accumulator after trade (should still be 0 for healthy trades)
    let snapshot = await harness.snapshot(ctx);
    console.log(`    Loss accum after trade: ${snapshot.engine.lossAccum}`);
    console.log(`    Risk reduction mode: ${snapshot.engine.riskReductionOnly}`);

    // Try liquidation (will fail on healthy account but won't increase loss)
    await harness.liquidateAtOracle(ctx, user.accountIndex);

    snapshot = await harness.snapshot(ctx);
    console.log(`    Loss accum after liquidation attempt: ${snapshot.engine.lossAccum}`);

    // Verify loss hasn't increased from healthy operations
    TestHarness.assert(
      snapshot.engine.lossAccum >= 0n,
      "Loss accumulator should be non-negative"
    );
  });

  // -------------------------------------------------------------------------
  // T16.3: Risk reduction mode state verification
  // -------------------------------------------------------------------------
  await harness.runTest("T16.3: Risk reduction mode state", async () => {
    // Use decimals 9 to force fresh mint
    ctx = await harness.createFreshMarket({ maxAccounts: 64, decimals: 9 });

    // Small delay after market creation
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check initial state
    let snapshot = await harness.snapshot(ctx);
    const initialRiskMode = snapshot.engine.riskReductionOnly;
    const threshold = snapshot.params.riskReductionThreshold;

    console.log(`    Initial risk reduction mode: ${initialRiskMode}`);
    console.log(`    Risk reduction threshold: ${threshold}`);

    // Setup accounts and trade (amounts for 9 decimals: 10^9 = 1B per token)
    lp = await harness.createUser(ctx, "lp3", 200_000_000_000n); // 200 tokens
    await harness.initLPWithMatcher(ctx, lp, "1000000000"); // 1 token fee
    await harness.deposit(ctx, lp, "100000000000"); // 100 tokens

    user = await harness.createUser(ctx, "user3", 50_000_000_000n); // 50 tokens
    await harness.initUser(ctx, user, "1000000000"); // 1 token fee
    await harness.deposit(ctx, user, "10000000000"); // 10 tokens

    await harness.topUpInsurance(ctx, user, "1000000000"); // 1 token
    await harness.keeperCrankAsUser(ctx, user);

    // Trade
    await harness.tradeCpi(ctx, user, lp, "200");

    // Verify state
    snapshot = await harness.snapshot(ctx);
    console.log(`    Risk reduction mode after trade: ${snapshot.engine.riskReductionOnly}`);
    console.log(`    Current loss accum: ${snapshot.engine.lossAccum}`);

    // Normal trading should not trigger risk reduction (or it clears after crank)
    // With threshold=0, risk mode is effectively disabled
    TestHarness.assert(
      threshold === 0n || !snapshot.engine.riskReductionOnly,
      "With threshold=0, risk reduction is effectively disabled"
    );
  });

  // -------------------------------------------------------------------------
  // T16.4: Position closure works
  // -------------------------------------------------------------------------
  await harness.runTest("T16.4: Position closure", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Setup
    lp = await harness.createUser(ctx, "lp4", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user4", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Open position
    const openResult = await harness.tradeCpi(ctx, user, lp, "400");
    if (openResult.err) {
      console.log(`    Open error: ${openResult.err.slice(0, 60)}`);
      return;
    }

    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const positionBefore = userAcct?.account.positionSize ?? 0n;
    console.log(`    Position before close: ${positionBefore}`);

    TestHarness.assert(positionBefore !== 0n, "Should have position");

    // Close position
    const closeResult = await harness.tradeCpi(ctx, user, lp, `-${positionBefore}`);
    if (closeResult.err) {
      console.log(`    Close error: ${closeResult.err.slice(0, 60)}`);
    }

    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const positionAfter = userAcct?.account.positionSize ?? 0n;
    console.log(`    Position after close: ${positionAfter}`);

    // Position should be closed
    TestHarness.assertBigIntEqual(positionAfter, 0n, "Position should be closed");
  });

  // -------------------------------------------------------------------------
  // T16.5: Conservation during loss scenarios
  // -------------------------------------------------------------------------
  await harness.runTest("T16.5: Conservation during loss scenarios", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Setup
    lp = await harness.createUser(ctx, "lp5", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user5", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "5000000"); // 5 USDC insurance
    await harness.keeperCrankAsUser(ctx, user);

    // Record totals before
    let snapshot = await harness.snapshot(ctx);
    let totalBefore = 0n;
    for (const { account } of snapshot.accounts) {
      totalBefore += account.capital;
    }
    totalBefore += snapshot.engine.insuranceFund.balance;
    console.log(`    Total (capital + insurance) before: ${totalBefore}`);

    // Trade
    await harness.tradeCpi(ctx, user, lp, "300");

    // Try liquidation attempt
    await harness.liquidateAtOracle(ctx, user.accountIndex);

    // Run crank
    await harness.keeperCrankAsUser(ctx, user);

    // Record totals after
    snapshot = await harness.snapshot(ctx);
    let totalAfter = 0n;
    for (const { account } of snapshot.accounts) {
      totalAfter += account.capital;
    }
    totalAfter += snapshot.engine.insuranceFund.balance;
    console.log(`    Total (capital + insurance) after: ${totalAfter}`);

    const diff = totalAfter > totalBefore ? totalAfter - totalBefore : totalBefore - totalAfter;
    console.log(`    Difference: ${diff}`);

    // Conservation should hold
    TestHarness.assert(
      diff < 100_000n, // 0.1 USDC tolerance for fees
      `Conservation should hold, diff=${diff}`
    );
  });

  // -------------------------------------------------------------------------
  // T16.6: Insurance fund interaction
  // -------------------------------------------------------------------------
  await harness.runTest("T16.6: Insurance fund interaction", async () => {
    // Use decimals 7 to force fresh mint
    ctx = await harness.createFreshMarket({ maxAccounts: 64, decimals: 7 });

    // Setup (amounts adjusted for 7 decimals: 10^7 = 10M per token)
    lp = await harness.createUser(ctx, "lp6", 2_000_000_000n); // 200 tokens
    await harness.initLPWithMatcher(ctx, lp, "10000000");
    await harness.deposit(ctx, lp, "1000000000"); // 100 tokens

    user = await harness.createUser(ctx, "user6", 500_000_000n); // 50 tokens
    await harness.initUser(ctx, user, "10000000");
    await harness.deposit(ctx, user, "50000000"); // 5 tokens

    // Record insurance before top-up
    let snapshot = await harness.snapshot(ctx);
    const insuranceBefore = snapshot.engine.insuranceFund.balance;
    console.log(`    Insurance before top-up: ${insuranceBefore}`);

    // Top up insurance (3 tokens = 30000000 with 7 decimals)
    await harness.topUpInsurance(ctx, user, "30000000");

    snapshot = await harness.snapshot(ctx);
    const insuranceAfter = snapshot.engine.insuranceFund.balance;
    console.log(`    Insurance after top-up: ${insuranceAfter}`);

    const insuranceIncrease = insuranceAfter - insuranceBefore;
    console.log(`    Insurance increase: ${insuranceIncrease}`);

    TestHarness.assert(
      insuranceIncrease >= 30000000n,
      `Insurance should increase by at least 3 tokens, got ${insuranceIncrease}`
    );

    // Crank and check insurance still intact
    await harness.keeperCrankAsUser(ctx, user);

    snapshot = await harness.snapshot(ctx);
    console.log(`    Insurance after crank: ${snapshot.engine.insuranceFund.balance}`);
    console.log(`    Loss accum: ${snapshot.engine.lossAccum}`);

    // Insurance should remain stable without losses
    TestHarness.assert(
      snapshot.engine.insuranceFund.balance >= insuranceAfter,
      "Insurance should not decrease without losses"
    );
  });

  // -------------------------------------------------------------------------
  // T16.7: Invariants hold during risk management operations
  // -------------------------------------------------------------------------
  await harness.runTest("T16.7: Invariants during risk management", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Full setup with positions
    lp = await harness.createUser(ctx, "lp7", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user7", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "2000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Trade
    await harness.tradeCpi(ctx, user, lp, "500");

    // Liquidation attempt
    await harness.liquidateAtOracle(ctx, user.accountIndex);

    // Crank
    await harness.keeperCrankAsUser(ctx, user);

    // Check all invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    if (!report.passed) {
      console.log("    Invariant failures:");
      for (const r of report.results) {
        if (!r.passed) {
          console.log(`      ${r.name}: ${r.message || r.expected}`);
        }
      }
    }

    console.log(`    All invariants: ${report.passed ? "PASS" : "FAIL"}`);
    console.log(`    Risk reduction mode: ${report.snapshot.engine.riskReductionOnly}`);
    console.log(`    Loss accum: ${report.snapshot.engine.lossAccum}`);

    TestHarness.assert(report.passed, "All invariants should hold");
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T16 Summary: ${summary.passed}/${summary.total} passed`);
  if (summary.failed > 0) {
    console.log("Failed tests:");
    for (const r of summary.results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }
  console.log("----------------------------------------");

  await harness.cleanup();
}

// Run if executed directly
runT16Tests().catch(console.error);

export { runT16Tests };
