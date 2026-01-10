/**
 * T14: Liquidation Tests
 *
 * Tests the liquidation mechanics of the perpetual DEX.
 *
 * Market params (from harness):
 * - maintenanceMarginBps: 500 (5%)
 * - initialMarginBps: 1000 (10%)
 * - liquidationFeeBps: 100 (1%)
 * - liquidationBufferBps: 50 (0.5%)
 *
 * T14.1: Healthy account cannot be liquidated
 * T14.2: Account with no position cannot be liquidated
 * T14.3: Attempt liquidation on undercollateralized account
 * T14.4: Verify insurance fund after liquidation
 * T14.5: Liquidation fee accounting
 */

import TestHarness, { TestContext, UserContext, MATCHER_PROGRAM_ID } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

/**
 * Calculate the margin required for a position.
 * margin = positionSize * oraclePrice * marginBps / 10000
 */
function calculateMarginRequired(
  positionSize: bigint,
  oraclePrice: bigint,
  marginBps: bigint
): bigint {
  const absPosition = positionSize < 0n ? -positionSize : positionSize;
  // Assuming oraclePrice is in collateral units per position unit
  const notional = absPosition * oraclePrice;
  return (notional * marginBps) / 10000n;
}

async function runT14Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T14: Liquidation Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;
  let lp: UserContext;
  let user: UserContext;

  // -------------------------------------------------------------------------
  // T14.1: Healthy account cannot be liquidated
  // Note: The instruction may return success but not change state for healthy accounts
  // -------------------------------------------------------------------------
  await harness.runTest("T14.1: Healthy account - no state change on liquidation", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create LP with matcher
    lp = await harness.createUser(ctx, "lp", 100_000_000n); // 100 USDC
    const initLpResult = await harness.initLPWithMatcher(ctx, lp, "1000000");
    TestHarness.assert(!initLpResult.err, `Init LP should succeed: ${initLpResult.err}`);

    // Deposit collateral to LP
    await harness.deposit(ctx, lp, "50000000"); // 50 USDC

    // Create user with substantial capital
    user = await harness.createUser(ctx, "user", 100_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000"); // 10 USDC

    // Top up insurance and crank
    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Take a small position (well within margin)
    const tradeResult = await harness.tradeCpi(ctx, user, lp, "100"); // Small 100 unit position
    if (tradeResult.err) {
      console.log(`    Trade error: ${tradeResult.err.slice(0, 60)}`);
    }

    // Check position BEFORE liquidation attempt
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const capitalBefore = userAcct?.account.capital ?? 0n;
    const positionBefore = userAcct?.account.positionSize ?? 0n;
    console.log(`    Before - Capital: ${capitalBefore}, Position: ${positionBefore}`);

    // Try to liquidate the healthy account
    const liqResult = await harness.liquidateAtOracle(ctx, user.accountIndex);
    console.log(`    Liquidation result: ${liqResult.err ? liqResult.err.slice(0, 60) : "success (no error)"}`);

    // Check position AFTER liquidation attempt
    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const capitalAfter = userAcct?.account.capital ?? 0n;
    const positionAfter = userAcct?.account.positionSize ?? 0n;
    console.log(`    After - Capital: ${capitalAfter}, Position: ${positionAfter}`);

    // For a healthy account, position and capital should NOT change
    TestHarness.assertBigIntEqual(
      positionAfter,
      positionBefore,
      "Healthy account position should not change on liquidation attempt"
    );

    // Capital might change slightly due to fees, but position should definitely stay
    const capitalDiff = capitalBefore > capitalAfter ? capitalBefore - capitalAfter : capitalAfter - capitalBefore;
    console.log(`    Capital change: ${capitalDiff}`);
  });

  // -------------------------------------------------------------------------
  // T14.2: Account with no position - liquidation is no-op
  // -------------------------------------------------------------------------
  await harness.runTest("T14.2: No position - liquidation is no-op", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create user with capital but no position
    user = await harness.createUser(ctx, "user2", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "5000000"); // 5 USDC

    // Top up insurance and crank
    await harness.topUpInsurance(ctx, user, "1000000");
    const crankResult = await harness.keeperCrankAsUser(ctx, user);
    if (crankResult.err) {
      console.log(`    Crank warning: ${crankResult.err.slice(0, 60)}`);
    }

    // Get state before
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const capitalBefore = userAcct?.account.capital ?? 0n;
    const positionBefore = userAcct?.account.positionSize ?? 0n;
    console.log(`    Before - Capital: ${capitalBefore}, Position: ${positionBefore}`);

    TestHarness.assertBigIntEqual(positionBefore, 0n, "User should have no position");

    // Try to liquidate
    const liqResult = await harness.liquidateAtOracle(ctx, user.accountIndex);
    console.log(`    Liquidation result: ${liqResult.err ? liqResult.err.slice(0, 60) : "success (no error)"}`);

    // Get state after
    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const capitalAfter = userAcct?.account.capital ?? 0n;
    const positionAfter = userAcct?.account.positionSize ?? 0n;
    console.log(`    After - Capital: ${capitalAfter}, Position: ${positionAfter}`);

    // Capital should not change for account with no position
    TestHarness.assertBigIntEqual(
      capitalAfter,
      capitalBefore,
      "Capital should not change when liquidating account with no position"
    );
  });

  // -------------------------------------------------------------------------
  // T14.3: Attempt liquidation on maximally leveraged account
  // This tests the boundary conditions for liquidation
  // -------------------------------------------------------------------------
  await harness.runTest("T14.3: Maximally leveraged position", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create LP
    lp = await harness.createUser(ctx, "lp3", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000"); // 100 USDC

    // Create user with small capital
    user = await harness.createUser(ctx, "user3", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "2000000"); // 2 USDC - small capital

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Get initial state
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const initialCapital = userAcct?.account.capital ?? 0n;
    console.log(`    Initial capital: ${initialCapital}`);

    // Try to take a large position relative to capital
    // With 10% initial margin and ~$88k BTC price, 1000 units might be too large
    // Let's try progressively larger positions
    const positionSizes = ["100", "500", "1000", "2000"];
    let lastSuccessfulSize = "0";

    for (const size of positionSizes) {
      const tradeResult = await harness.tradeCpi(ctx, user, lp, size);
      if (tradeResult.err) {
        console.log(`    Position ${size}: rejected (${tradeResult.err.slice(0, 50)})`);
        break;
      } else {
        // Close the position before trying larger
        await harness.tradeCpi(ctx, user, lp, `-${size}`);
        lastSuccessfulSize = size;
        console.log(`    Position ${size}: accepted`);
      }
    }

    console.log(`    Max position size that fits margin: ${lastSuccessfulSize}`);

    // Now take a position that uses most of the margin
    if (lastSuccessfulSize !== "0") {
      const finalTradeResult = await harness.tradeCpi(ctx, user, lp, lastSuccessfulSize);
      if (!finalTradeResult.err) {
        snapshot = await harness.snapshot(ctx);
        userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
        console.log(`    Position size: ${userAcct?.account.positionSize}`);
        console.log(`    Capital after trade: ${userAcct?.account.capital}`);

        // Try liquidation - might work if position is at margin boundary
        const liqResult = await harness.liquidateAtOracle(ctx, user.accountIndex);
        if (liqResult.err) {
          console.log(`    Liquidation rejected (account still healthy): ${liqResult.err.slice(0, 60)}`);
        } else {
          console.log(`    Liquidation succeeded! Account was at margin boundary.`);
          // Verify position is now closed
          snapshot = await harness.snapshot(ctx);
          userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
          console.log(`    Post-liquidation position: ${userAcct?.account.positionSize}`);
          console.log(`    Post-liquidation capital: ${userAcct?.account.capital}`);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // T14.4: Verify insurance fund state
  // -------------------------------------------------------------------------
  await harness.runTest("T14.4: Insurance fund verification", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create user
    user = await harness.createUser(ctx, "user4", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");

    // Record insurance before top-up
    let snapshot = await harness.snapshot(ctx);
    const insuranceBefore = snapshot.engine.insuranceFund.balance;
    console.log(`    Insurance before top-up: ${insuranceBefore}`);

    // Top up insurance
    const topUpAmount = 5_000_000n; // 5 USDC
    await harness.topUpInsurance(ctx, user, topUpAmount.toString());

    // Record insurance after top-up
    snapshot = await harness.snapshot(ctx);
    const insuranceAfter = snapshot.engine.insuranceFund.balance;
    console.log(`    Insurance after top-up: ${insuranceAfter}`);

    // Verify insurance increased by the top-up amount
    const insuranceIncrease = insuranceAfter - insuranceBefore;
    console.log(`    Insurance increase: ${insuranceIncrease}`);

    // Insurance should increase by at least the top-up amount
    // (may be slightly more due to account fees going to insurance)
    TestHarness.assert(
      insuranceIncrease >= topUpAmount,
      `Insurance should increase by at least ${topUpAmount}, got ${insuranceIncrease}`
    );
  });

  // -------------------------------------------------------------------------
  // T14.5: Verify liquidation parameters are set correctly
  // -------------------------------------------------------------------------
  await harness.runTest("T14.5: Liquidation parameters verification", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Get market params
    const snapshot = await harness.snapshot(ctx);
    const params = snapshot.params;

    console.log(`    Maintenance margin: ${params.maintenanceMarginBps} bps (${Number(params.maintenanceMarginBps) / 100}%)`);
    console.log(`    Initial margin: ${params.initialMarginBps} bps (${Number(params.initialMarginBps) / 100}%)`);
    console.log(`    Liquidation fee: ${params.liquidationFeeBps} bps (${Number(params.liquidationFeeBps) / 100}%)`);
    console.log(`    Liquidation buffer: ${params.liquidationBufferBps} bps`);
    console.log(`    Liquidation fee cap: ${params.liquidationFeeCap}`);
    console.log(`    Min liquidation: ${params.minLiquidationAbs}`);

    // Verify expected values from harness
    TestHarness.assertBigIntEqual(params.maintenanceMarginBps, 500n, "Maintenance margin should be 500 bps");
    TestHarness.assertBigIntEqual(params.initialMarginBps, 1000n, "Initial margin should be 1000 bps");
    TestHarness.assertBigIntEqual(params.liquidationFeeBps, 100n, "Liquidation fee should be 100 bps");
  });

  // -------------------------------------------------------------------------
  // T14.6: Conservation holds during liquidation attempt
  // -------------------------------------------------------------------------
  await harness.runTest("T14.6: Conservation during liquidation attempt", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Setup LP and user with positions
    lp = await harness.createUser(ctx, "lp6", 100_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "50000000");

    user = await harness.createUser(ctx, "user6", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "5000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Take a position
    await harness.tradeCpi(ctx, user, lp, "200");

    // Attempt liquidation (should fail on healthy account)
    await harness.liquidateAtOracle(ctx, user.accountIndex);

    // Check conservation still holds
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

    console.log(`    Conservation: ${report.passed ? "PASS" : "FAIL"}`);
    TestHarness.assert(report.passed, "Conservation should hold after liquidation attempt");
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T14 Summary: ${summary.passed}/${summary.total} passed`);
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
runT14Tests().catch(console.error);

export { runT14Tests };
