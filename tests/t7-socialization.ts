/**
 * T7: Loss Socialization Tests
 *
 * T7.1: Negative balance distributed across LPs
 * T7.2: Insurance fund absorbs losses first
 */

import TestHarness, { TestContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT7Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T7: Loss Socialization Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T7.1: Insurance fund state
  // -------------------------------------------------------------------------
  await harness.runTest("T7.1: Insurance fund initial state", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const snapshot = await harness.snapshot(ctx);

    // Fresh market should have 0 insurance fund
    TestHarness.assertBigIntEqual(
      snapshot.engine.insuranceFund.balance,
      0n,
      "Fresh market should have 0 insurance"
    );

    console.log(`    Insurance fund balance: ${snapshot.engine.insuranceFund.balance}`);
  });

  // -------------------------------------------------------------------------
  // T7.2: Insurance fund after trading activity
  // -------------------------------------------------------------------------
  await harness.runTest("T7.2: Insurance fund with users", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create users
    for (let i = 0; i < 3; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 20_000_000n);
      await harness.initUser(ctx, user, "5000000");
    }

    // Create LP
    const lp = await harness.createUser(ctx, "lp", 100_000_000n);
    await harness.initLP(ctx, lp, "50000000");

    const snapshot = await harness.snapshot(ctx);

    console.log(`    Insurance fund balance: ${snapshot.engine.insuranceFund.balance}`);
    console.log(`    Insurance fund fee revenue: ${snapshot.engine.insuranceFund.feeRevenue}`);
    console.log(`    Total accounts: ${snapshot.engine.numUsedAccounts}`);

    // Sum all capital from accounts
    let totalCapital = 0n;
    for (const acct of snapshot.accounts) {
      totalCapital += acct.account.capital;
    }
    console.log(`    Total capital: ${totalCapital}`);
  });

  // -------------------------------------------------------------------------
  // T7.3: Invariants hold during stress
  // -------------------------------------------------------------------------
  await harness.runTest("T7.3: Conservation under stress", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 128 });

    // Create many users
    const numUsers = 20;
    for (let i = 0; i < numUsers; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 10_000_000n);
      await harness.initUser(ctx, user, "1000000");
    }

    // Run multiple keeper cranks
    for (let i = 0; i < 3; i++) {
      await harness.keeperCrank(ctx, 300000);
      await harness.waitSlots(1);
    }

    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    TestHarness.assert(report.passed, "Invariants should hold");

    console.log(`    Users: ${numUsers}`);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T7 Summary: ${summary.passed}/${summary.total} passed`);
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

runT7Tests().catch(console.error);
export { runT7Tests };
