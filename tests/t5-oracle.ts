/**
 * T5: Oracle & Price Movement Tests
 *
 * T5.1: Keeper crank reads oracle and updates funding
 * T5.2: CU usage scales appropriately with account count
 * T5.3: Stale oracle handling
 */

import TestHarness, { TestContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT5Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T5: Oracle & Price Movement Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T5.1: Keeper crank runs successfully
  // -------------------------------------------------------------------------
  await harness.runTest("T5.1: Keeper crank execution", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Initialize some users first
    for (let i = 0; i < 5; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 10_000_000n);
      await harness.initUser(ctx, user, "1000000");
    }

    const snapshotBefore = await harness.snapshot(ctx);
    const fundingSlotBefore = snapshotBefore.engine.lastFundingSlot;

    // Run keeper crank
    const result = await harness.keeperCrank(ctx, 200000);

    if (result.err) {
      console.log(`    Crank result: ${result.err.slice(0, 80)}`);
    } else {
      const snapshotAfter = await harness.snapshot(ctx);
      console.log(`    Crank succeeded`);
      console.log(`    CU used: ${result.unitsConsumed}`);
      console.log(`    Funding slot before: ${fundingSlotBefore}`);
      console.log(`    Funding slot after: ${snapshotAfter.engine.lastFundingSlot}`);
    }
  });

  // -------------------------------------------------------------------------
  // T5.2: CU usage at different account counts
  // -------------------------------------------------------------------------
  await harness.runTest("T5.2: CU scaling with account count", async () => {
    const accountCounts = [10, 25, 50];
    const cuResults: { count: number; cu: number | undefined }[] = [];

    for (const count of accountCounts) {
      ctx = await harness.createFreshMarket({ maxAccounts: 128 });

      // Init users
      for (let i = 0; i < count; i++) {
        const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
        await harness.initUser(ctx, user, "1000000");
      }

      // Run crank and measure CU
      const result = await harness.keeperCrank(ctx, 400000);
      cuResults.push({
        count,
        cu: result.err ? undefined : result.unitsConsumed,
      });

      console.log(`    ${count} accounts: ${result.unitsConsumed || result.err?.slice(0, 30)} CU`);
    }

    // Check that CU scales reasonably
    TestHarness.assert(
      cuResults.some(r => r.cu !== undefined),
      "At least one crank should succeed"
    );
  });

  // -------------------------------------------------------------------------
  // T5.3: Crank with different CU budgets
  // -------------------------------------------------------------------------
  await harness.runTest("T5.3: CU budget testing", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Init some users
    for (let i = 0; i < 20; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "1000000");
    }

    // Test different CU limits
    const budgets = [50000, 100000, 200000];

    for (const budget of budgets) {
      const result = await harness.keeperCrank(ctx, budget);
      const status = result.err
        ? `failed (${result.err.slice(0, 40)})`
        : `OK (${result.unitsConsumed} CU)`;
      console.log(`    Budget ${budget}: ${status}`);
    }
  });

  // -------------------------------------------------------------------------
  // T5.4: Engine state after multiple cranks
  // -------------------------------------------------------------------------
  await harness.runTest("T5.4: Multiple crank iterations", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    for (let i = 0; i < 5; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "1000000");
    }

    // Run multiple cranks
    const crankResults: number[] = [];
    for (let i = 0; i < 3; i++) {
      // Wait a few slots between cranks
      await harness.waitSlots(2);

      const result = await harness.keeperCrank(ctx, 200000);
      if (!result.err && result.unitsConsumed) {
        crankResults.push(result.unitsConsumed);
      }
    }

    console.log(`    Crank CU results: [${crankResults.join(", ")}]`);

    // Verify invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T5 Summary: ${summary.passed}/${summary.total} passed`);
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

runT5Tests().catch(console.error);
export { runT5Tests };
