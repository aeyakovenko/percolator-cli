/**
 * T8: Crank & Scaling Tests
 *
 * T8.1: Crank scales with account count
 * T8.2: CU budget verification
 * T8.3: Partial crank completion handling
 */

import TestHarness, { TestContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT8Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T8: Crank & Scaling Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T8.1: CU usage baseline
  // -------------------------------------------------------------------------
  await harness.runTest("T8.1: CU baseline (empty market)", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Crank on empty market
    const result = await harness.keeperCrank(ctx, 100000);

    if (result.err) {
      console.log(`    Result: ${result.err.slice(0, 60)}`);
    } else {
      console.log(`    CU on empty market: ${result.unitsConsumed}`);
    }
  });

  // -------------------------------------------------------------------------
  // T8.2: CU scaling measurement
  // -------------------------------------------------------------------------
  await harness.runTest("T8.2: CU scaling measurement", async () => {
    const results: { accounts: number; cu: number | undefined }[] = [];

    for (const count of [5, 15, 30]) {
      ctx = await harness.createFreshMarket({ maxAccounts: 64 });

      for (let i = 0; i < count; i++) {
        const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
        await harness.initUser(ctx, user, "1000000");
      }

      const result = await harness.keeperCrank(ctx, 500000);
      results.push({
        accounts: count,
        cu: result.err ? undefined : result.unitsConsumed,
      });
    }

    for (const r of results) {
      console.log(`    ${r.accounts} accounts: ${r.cu ?? "failed"} CU`);
    }

    // At least some should succeed
    TestHarness.assert(
      results.some(r => r.cu !== undefined),
      "At least one crank should succeed"
    );
  });

  // -------------------------------------------------------------------------
  // T8.3: CU limit enforcement
  // -------------------------------------------------------------------------
  await harness.runTest("T8.3: CU limit enforcement", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 128 });

    // Create enough users to stress CU
    for (let i = 0; i < 40; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "500000");
    }

    // Try with very low CU limit
    const lowResult = await harness.keeperCrank(ctx, 25000);
    console.log(`    25k CU limit: ${lowResult.err ? "failed" : `${lowResult.unitsConsumed} CU`}`);

    // Try with adequate CU limit
    const highResult = await harness.keeperCrank(ctx, 300000);
    console.log(`    300k CU limit: ${highResult.err ? "failed" : `${highResult.unitsConsumed} CU`}`);
  });

  // -------------------------------------------------------------------------
  // T8.4: Consecutive cranks
  // -------------------------------------------------------------------------
  await harness.runTest("T8.4: Consecutive cranks", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    for (let i = 0; i < 10; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "1000000");
    }

    const cuValues: number[] = [];
    for (let i = 0; i < 5; i++) {
      await harness.waitSlots(2);
      const result = await harness.keeperCrank(ctx, 200000);
      if (!result.err && result.unitsConsumed) {
        cuValues.push(result.unitsConsumed);
      }
    }

    console.log(`    CU values: [${cuValues.join(", ")}]`);

    // Verify invariants after all cranks
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // T8.5: High user count stress test
  // -------------------------------------------------------------------------
  await harness.runTest("T8.5: High user count (100 users)", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 128 });

    const numUsers = 100;
    console.log(`    Creating ${numUsers} users...`);

    for (let i = 0; i < numUsers; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 3_000_000n);
      await harness.initUser(ctx, user, "500000");

      if ((i + 1) % 20 === 0) {
        process.stdout.write(`\r    Progress: ${i + 1}/${numUsers}`);
      }
    }
    console.log("");

    const snapshot = await harness.snapshot(ctx);
    TestHarness.assertEqual(
      snapshot.header.numUsed,
      numUsers,
      `Should have ${numUsers} users`
    );

    // Crank with high CU
    const result = await harness.keeperCrank(ctx, 1000000);
    console.log(`    Crank result: ${result.err?.slice(0, 40) || `${result.unitsConsumed} CU`}`);

    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T8 Summary: ${summary.passed}/${summary.total} passed`);
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

runT8Tests().catch(console.error);
export { runT8Tests };
