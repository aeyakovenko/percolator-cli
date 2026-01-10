/**
 * T1: Market Boot & Layout Tests
 *
 * T1.1: Fresh market has correct magic number, version, and layout
 * T1.2: Empty market invariants (numUsed=0, nextId=2, bitmap cleared)
 */

import TestHarness, { TestContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker, printInvariantReport } from "./invariants.js";

const EXPECTED_MAGIC = 0x504552434f4c4154n; // "PERCOLAT"
const EXPECTED_VERSION = 1;

async function runT1Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T1: Market Boot & Layout Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T1.1: Magic number and version check
  // -------------------------------------------------------------------------
  await harness.runTest("T1.1: Magic number and version", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });
    const snapshot = await harness.snapshot(ctx);

    TestHarness.assertEqual(
      snapshot.header.magic,
      EXPECTED_MAGIC,
      "Magic number mismatch"
    );

    TestHarness.assertEqual(
      snapshot.header.version,
      EXPECTED_VERSION,
      "Version mismatch"
    );

    console.log(`    Magic: 0x${snapshot.header.magic.toString(16)}`);
    console.log(`    Version: ${snapshot.header.version}`);
  });

  // -------------------------------------------------------------------------
  // T1.2: Empty market invariants
  // -------------------------------------------------------------------------
  await harness.runTest("T1.2: Empty market invariants", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });
    const snapshot = await harness.snapshot(ctx);

    // numUsedAccounts should be 0 for fresh market (in engine state)
    TestHarness.assertEqual(
      snapshot.engine.numUsedAccounts,
      0,
      "Fresh market should have 0 used accounts"
    );

    // nextAccountId should be 0 for a fresh market (first account will get ID 0)
    TestHarness.assertBigIntEqual(
      snapshot.engine.nextAccountId,
      0n,
      "Fresh market nextAccountId should be 0"
    );

    // maxAccounts should match what we requested (in params)
    TestHarness.assertBigIntEqual(
      snapshot.params.maxAccounts,
      64n,
      "maxAccounts mismatch"
    );

    // usedIndices should be empty
    TestHarness.assertEqual(
      snapshot.usedIndices.length,
      0,
      "Fresh market should have no used indices"
    );

    // Insurance fund balance should be 0
    TestHarness.assertBigIntEqual(
      snapshot.engine.insuranceFund.balance,
      0n,
      "Fresh market insurance fund should be 0"
    );

    console.log(`    numUsedAccounts: ${snapshot.engine.numUsedAccounts}`);
    console.log(`    nextAccountId: ${snapshot.engine.nextAccountId}`);
    console.log(`    maxAccounts: ${snapshot.params.maxAccounts}`);
    console.log(`    insuranceFund: ${snapshot.engine.insuranceFund.balance}`);
  });

  // -------------------------------------------------------------------------
  // T1.3: Market config verification
  // -------------------------------------------------------------------------
  await harness.runTest("T1.3: Market config verification", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 128 });
    const snapshot = await harness.snapshot(ctx);

    // Verify params values match init params (risk params are in params, not config)
    TestHarness.assert(
      snapshot.params.initialMarginBps > 0n,
      "IM ratio should be positive"
    );
    TestHarness.assert(
      snapshot.params.maintenanceMarginBps > 0n,
      "MM ratio should be positive"
    );
    TestHarness.assert(
      snapshot.params.initialMarginBps >= snapshot.params.maintenanceMarginBps,
      "IM ratio should be >= MM ratio"
    );

    console.log(`    initialMarginBps: ${snapshot.params.initialMarginBps}`);
    console.log(`    maintenanceMarginBps: ${snapshot.params.maintenanceMarginBps}`);
    console.log(`    tradingFeeBps: ${snapshot.params.tradingFeeBps}`);
  });

  // -------------------------------------------------------------------------
  // T1.4: Slab size calculation
  // -------------------------------------------------------------------------
  await harness.runTest("T1.4: Slab size matches maxAccounts", async () => {
    // Create markets with different sizes
    const sizes = [32, 64, 256];

    for (const maxAccounts of sizes) {
      const testCtx = await harness.createFreshMarket({ maxAccounts });
      const snapshot = await harness.snapshot(testCtx);

      TestHarness.assertBigIntEqual(
        snapshot.params.maxAccounts,
        BigInt(maxAccounts),
        `maxAccounts should be ${maxAccounts}`
      );

      // Fresh market should have 0 accounts
      TestHarness.assertEqual(
        snapshot.accounts.length,
        0,
        `Fresh market should have 0 accounts`
      );

      console.log(`    Verified maxAccounts=${maxAccounts}`);
    }
  });

  // -------------------------------------------------------------------------
  // T1.5: Full invariant check on fresh market
  // -------------------------------------------------------------------------
  await harness.runTest("T1.5: Fresh market passes all invariants", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    if (!report.passed) {
      printInvariantReport(report);
      throw new Error("Invariant check failed");
    }

    console.log("    All invariants passed");
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T1 Summary: ${summary.passed}/${summary.total} passed`);
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

// Run if executed directly
runT1Tests().catch(console.error);

export { runT1Tests };
