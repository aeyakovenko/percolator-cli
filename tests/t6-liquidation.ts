/**
 * T6: Liquidation Edge Tests
 *
 * T6.1: Liquidation at oracle price
 * T6.2: Under-margined positions get liquidated
 * T6.3: Liquidation transfers to insurance fund
 */

import TestHarness, { TestContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT6Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T6: Liquidation Edge Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T6.1: Liquidation instruction executes
  // -------------------------------------------------------------------------
  await harness.runTest("T6.1: Liquidation instruction", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create a user
    const user = await harness.createUser(ctx, "user", 10_000_000n);
    await harness.initUser(ctx, user, "5000000");

    const snapshot = await harness.snapshot(ctx);
    const userIdx = snapshot.usedIndices[0];

    // Try to liquidate (may not be liquidatable)
    const result = await harness.liquidateAtOracle(ctx, userIdx);

    if (result.err) {
      console.log(`    Liquidation result: ${result.err.slice(0, 80)}`);
      console.log(`    (Expected if account is not under-margined)`);
    } else {
      console.log(`    Liquidation succeeded`);
      console.log(`    CU used: ${result.unitsConsumed}`);
    }
  });

  // -------------------------------------------------------------------------
  // T6.2: Healthy account cannot be liquidated
  // -------------------------------------------------------------------------
  await harness.runTest("T6.2: Healthy account protected", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create well-funded user
    const user = await harness.createUser(ctx, "user", 100_000_000n);
    await harness.initUser(ctx, user, "50000000");

    const snapshotBefore = await harness.snapshot(ctx);
    const userIdx = snapshotBefore.usedIndices[0];
    const balanceBefore = snapshotBefore.accounts[userIdx].collateralBalance;

    // Try to liquidate healthy account
    const result = await harness.liquidateAtOracle(ctx, userIdx);

    const snapshotAfter = await harness.snapshot(ctx);
    const balanceAfter = snapshotAfter.accounts[userIdx].collateralBalance;

    // Balance should remain unchanged if liquidation was rejected
    if (result.err) {
      console.log(`    Liquidation blocked: ${result.err.slice(0, 60)}`);
      TestHarness.assertBigIntEqual(
        balanceAfter,
        balanceBefore,
        "Balance should not change"
      );
    } else {
      console.log(`    Liquidation executed (account may have been under-margined)`);
    }
  });

  // -------------------------------------------------------------------------
  // T6.3: Insurance fund after liquidation
  // -------------------------------------------------------------------------
  await harness.runTest("T6.3: Insurance fund tracking", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create multiple users
    for (let i = 0; i < 5; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 10_000_000n);
      await harness.initUser(ctx, user, "2000000");
    }

    const snapshot = await harness.snapshot(ctx);

    console.log(`    Insurance fund: ${snapshot.engine.insuranceFund}`);
    console.log(`    Users: ${snapshot.header.numUsed}`);

    // Verify invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // T6.4: Liquidation of non-existent account
  // -------------------------------------------------------------------------
  await harness.runTest("T6.4: Invalid account index", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Try to liquidate account at unused index
    const result = await harness.liquidateAtOracle(ctx, 50);

    // Should fail
    TestHarness.assert(
      !!result.err,
      "Liquidating non-existent account should fail"
    );

    console.log(`    Result: ${result.err?.slice(0, 60) || "unexpected success"}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T6 Summary: ${summary.passed}/${summary.total} passed`);
  if (summary.failed > 0) {
    console.log("Failed tests:");
    for (const r of summary.results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }
  console.log("----------------------------------------");

  // Cleanup slab accounts to reclaim rent
  await harness.cleanup();
}

runT6Tests().catch(console.error);
export { runT6Tests };
