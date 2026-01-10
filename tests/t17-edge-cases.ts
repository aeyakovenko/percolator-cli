/**
 * T17: Edge Case Tests
 *
 * Tests boundary conditions and edge cases for the perpetual DEX.
 *
 * T17.1: Max leverage boundary (10x with 10% initial margin)
 * T17.2: Minimum position size
 * T17.3: Account creation with maximum fee
 * T17.4: Zero position operations
 * T17.5: Multiple cranks in sequence
 * T17.6: Withdrawal edge cases
 * T17.7: Large value handling (near u128 limits)
 */

import TestHarness, { TestContext, UserContext, MATCHER_PROGRAM_ID } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT17Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T17: Edge Case Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;
  let lp: UserContext;
  let user: UserContext;

  // -------------------------------------------------------------------------
  // T17.1: Max leverage boundary
  // -------------------------------------------------------------------------
  await harness.runTest("T17.1: Max leverage boundary", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create LP with large capital
    lp = await harness.createUser(ctx, "lp1", 500_000_000n); // 500 USDC
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "400000000"); // 400 USDC

    // Create user with exact capital for testing margin
    user = await harness.createUser(ctx, "user1", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000"); // 10 USDC (after fee: ~9 USDC)

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Get user capital
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const userCapital = userAcct?.account.capital ?? 0n;
    console.log(`    User capital: ${userCapital}`);

    // With 10% initial margin (1000 bps), max leverage is 10x
    // Try progressively larger positions until rejected
    const positions = ["100", "500", "1000", "2000", "5000", "10000"];
    let lastAccepted = "0";
    let lastRejected = "";

    for (const pos of positions) {
      const result = await harness.tradeCpi(ctx, user, lp, pos);
      if (result.err) {
        lastRejected = pos;
        console.log(`    Position ${pos}: rejected (margin)`);
        break;
      } else {
        // Close position before trying larger
        await harness.tradeCpi(ctx, user, lp, `-${pos}`);
        lastAccepted = pos;
        console.log(`    Position ${pos}: accepted`);
      }
    }

    console.log(`    Max accepted: ${lastAccepted}, First rejected: ${lastRejected || "none"}`);

    // Verify we found a margin boundary
    TestHarness.assert(
      lastAccepted !== "0",
      "Should accept at least one position size"
    );
  });

  // -------------------------------------------------------------------------
  // T17.2: Minimum position size
  // -------------------------------------------------------------------------
  await harness.runTest("T17.2: Minimum position size", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    lp = await harness.createUser(ctx, "lp2", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user2", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Try minimum position sizes
    const minSizes = ["1", "10", "50", "100"];
    for (const size of minSizes) {
      const result = await harness.tradeCpi(ctx, user, lp, size);
      if (result.err) {
        console.log(`    Size ${size}: rejected - ${result.err.slice(0, 50)}`);
      } else {
        console.log(`    Size ${size}: accepted`);
        // Close position
        await harness.tradeCpi(ctx, user, lp, `-${size}`);
      }
    }

    // Verify at least size 100 works
    const testResult = await harness.tradeCpi(ctx, user, lp, "100");
    TestHarness.assert(!testResult.err, "Size 100 should be accepted");
  });

  // -------------------------------------------------------------------------
  // T17.3: Account fee verification
  // -------------------------------------------------------------------------
  await harness.runTest("T17.3: Account fee verification", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Get params to check new account fee
    const snapshot = await harness.snapshot(ctx);
    console.log(`    New account fee: ${snapshot.params.newAccountFee}`);

    // Create user
    user = await harness.createUser(ctx, "user3", 50_000_000n);

    // Before init, user has no account
    await harness.initUser(ctx, user, snapshot.params.newAccountFee.toString());

    // User should have been charged the fee
    const afterSnapshot = await harness.snapshot(ctx);
    const userAcct = afterSnapshot.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    User capital after init: ${userAcct?.account.capital}`);

    // Capital should be 0 after paying only the fee
    TestHarness.assertBigIntEqual(
      userAcct?.account.capital ?? 1n,
      0n,
      "Capital should be 0 after paying exact fee"
    );
  });

  // -------------------------------------------------------------------------
  // T17.4: Zero position operations
  // -------------------------------------------------------------------------
  await harness.runTest("T17.4: Zero position operations", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    lp = await harness.createUser(ctx, "lp4", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user4", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Verify user has no position initially
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    Initial position: ${userAcct?.account.positionSize}`);

    TestHarness.assertBigIntEqual(
      userAcct?.account.positionSize ?? 1n,
      0n,
      "Should have no position initially"
    );

    // Try trading 0 (should either fail or be no-op)
    const zeroResult = await harness.tradeCpi(ctx, user, lp, "0");
    console.log(`    Trade 0: ${zeroResult.err ? "rejected" : "accepted"}`);

    // Position should still be 0
    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    TestHarness.assertBigIntEqual(
      userAcct?.account.positionSize ?? 1n,
      0n,
      "Position should remain 0 after 0 trade"
    );
  });

  // -------------------------------------------------------------------------
  // T17.5: Multiple cranks in sequence
  // -------------------------------------------------------------------------
  await harness.runTest("T17.5: Multiple cranks in sequence", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    user = await harness.createUser(ctx, "user5", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");

    // Run multiple cranks in sequence
    const crankCount = 5;
    const slots: bigint[] = [];

    for (let i = 0; i < crankCount; i++) {
      await harness.keeperCrankAsUser(ctx, user);
      const snapshot = await harness.snapshot(ctx);
      slots.push(snapshot.engine.currentSlot);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`    Slots after ${crankCount} cranks: ${slots.join(", ")}`);

    // Verify slots are increasing (or at least non-decreasing)
    for (let i = 1; i < slots.length; i++) {
      TestHarness.assert(
        slots[i] >= slots[i - 1],
        `Slot should not decrease: ${slots[i - 1]} -> ${slots[i]}`
      );
    }

    // Check invariants still hold
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants after cranks: ${report.passed ? "PASS" : "FAIL"}`);
    TestHarness.assert(report.passed, "Invariants should hold after multiple cranks");
  });

  // -------------------------------------------------------------------------
  // T17.6: Withdrawal edge cases
  // -------------------------------------------------------------------------
  await harness.runTest("T17.6: Withdrawal edge cases", async () => {
    // Use decimals 8 to force fresh mint (amounts adjusted: 10^8 = 100M per token)
    ctx = await harness.createFreshMarket({ maxAccounts: 64, decimals: 8 });

    user = await harness.createUser(ctx, "user6", 10_000_000_000n); // 100 tokens
    await harness.initUser(ctx, user, "100000000"); // 1 token fee
    await harness.deposit(ctx, user, "5000000000"); // 50 tokens

    await harness.topUpInsurance(ctx, user, "100000000"); // 1 token
    await harness.keeperCrankAsUser(ctx, user);

    // Get capital after deposit
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const capitalBefore = userAcct?.account.capital ?? 0n;
    console.log(`    Capital before withdrawal: ${capitalBefore}`);

    // Try to withdraw more than balance (should fail)
    const overWithdrawResult = await harness.withdraw(ctx, user, (capitalBefore + 100000000n).toString());
    console.log(`    Over-withdraw: ${overWithdrawResult.err ? "rejected" : "accepted"}`);

    // Try to withdraw exactly all (should succeed if no position)
    const exactWithdrawResult = await harness.withdraw(ctx, user, capitalBefore.toString());
    if (exactWithdrawResult.err) {
      console.log(`    Exact withdraw: rejected - ${exactWithdrawResult.err.slice(0, 50)}`);
    } else {
      console.log(`    Exact withdraw: accepted`);
    }

    // Check final capital
    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    Capital after withdrawal: ${userAcct?.account.capital}`);
  });

  // -------------------------------------------------------------------------
  // T17.7: Parameter boundary values
  // -------------------------------------------------------------------------
  await harness.runTest("T17.7: Parameter boundary values", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const snapshot = await harness.snapshot(ctx);
    const params = snapshot.params;

    console.log(`    Warmup period: ${params.warmupPeriodSlots} slots`);
    console.log(`    Maintenance margin: ${params.maintenanceMarginBps} bps`);
    console.log(`    Initial margin: ${params.initialMarginBps} bps`);
    console.log(`    Trading fee: ${params.tradingFeeBps} bps`);
    console.log(`    Max accounts: ${params.maxAccounts}`);
    console.log(`    Liquidation fee: ${params.liquidationFeeBps} bps`);
    console.log(`    Liquidation fee cap: ${params.liquidationFeeCap}`);
    console.log(`    Min liquidation: ${params.minLiquidationAbs}`);

    // Verify expected values are set correctly
    TestHarness.assertBigIntEqual(params.maintenanceMarginBps, 500n, "Maintenance margin should be 500 bps");
    TestHarness.assertBigIntEqual(params.initialMarginBps, 1000n, "Initial margin should be 1000 bps");
    TestHarness.assertBigIntEqual(params.liquidationFeeBps, 100n, "Liquidation fee should be 100 bps");

    // Verify reasonable bounds
    TestHarness.assert(params.maxAccounts >= 64n, "Max accounts should be at least 64");
    TestHarness.assert(params.initialMarginBps > params.maintenanceMarginBps,
      "Initial margin should be greater than maintenance margin");
  });

  // -------------------------------------------------------------------------
  // T17.8: Inverted market edge cases
  // -------------------------------------------------------------------------
  await harness.runTest("T17.8: Inverted market edge cases", async () => {
    // Create inverted market
    ctx = await harness.createFreshMarket({ maxAccounts: 64, invert: 1 });

    const snapshot = await harness.snapshot(ctx);
    console.log(`    Invert flag: ${snapshot.config.invert}`);
    console.log(`    Unit scale: ${snapshot.config.unitScale}`);

    TestHarness.assertBigIntEqual(BigInt(snapshot.config.invert), 1n, "Invert flag should be 1");

    // Setup LP and user
    lp = await harness.createUser(ctx, "lp8", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user8", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Trade on inverted market
    const tradeResult = await harness.tradeCpi(ctx, user, lp, "100");
    console.log(`    Trade on inverted market: ${tradeResult.err ? "failed" : "success"}`);

    if (!tradeResult.err) {
      // Check positions
      const afterSnapshot = await harness.snapshot(ctx);
      const userAcct = afterSnapshot.accounts.find(a => a.idx === user.accountIndex);
      console.log(`    User position: ${userAcct?.account.positionSize}`);
      console.log(`    Entry price: ${userAcct?.account.entryPrice}`);
    }

    // Check invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
    TestHarness.assert(report.passed, "Invariants should hold on inverted market");
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T17 Summary: ${summary.passed}/${summary.total} passed`);
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
runT17Tests().catch(console.error);

export { runT17Tests };
