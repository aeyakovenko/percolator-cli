/**
 * T9: Determinism & Replay Tests
 *
 * T9.1: Same operations produce same hash
 * T9.2: State snapshots are consistent
 * T9.3: Account ordering is deterministic
 */

import TestHarness, { TestContext, SlabSnapshot, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT9Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T9: Determinism & Replay Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T9.1: Hash consistency
  // -------------------------------------------------------------------------
  await harness.runTest("T9.1: Hash consistency", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Take two snapshots in quick succession
    const snap1 = await harness.snapshot(ctx);
    const snap2 = await harness.snapshot(ctx);

    // Hashes should match (no state change between snapshots)
    TestHarness.assertEqual(
      snap1.rawHash,
      snap2.rawHash,
      "Consecutive snapshots should have same hash"
    );

    console.log(`    Hash: ${snap1.rawHash.slice(0, 32)}...`);
  });

  // -------------------------------------------------------------------------
  // T9.2: State changes produce different hash
  // -------------------------------------------------------------------------
  await harness.runTest("T9.2: State changes modify hash", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const snapBefore = await harness.snapshot(ctx);

    // Make a state change
    const user = await harness.createUser(ctx, "user", 10_000_000n);
    await harness.initUser(ctx, user, "1000000");

    const snapAfter = await harness.snapshot(ctx);

    // Hashes should differ
    TestHarness.assert(
      snapBefore.rawHash !== snapAfter.rawHash,
      "Hash should change after state modification"
    );

    console.log(`    Before: ${snapBefore.rawHash.slice(0, 32)}...`);
    console.log(`    After:  ${snapAfter.rawHash.slice(0, 32)}...`);
  });

  // -------------------------------------------------------------------------
  // T9.3: Account ID assignment is sequential
  // -------------------------------------------------------------------------
  await harness.runTest("T9.3: Sequential account IDs", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const numUsers = 10;
    const accountIds: bigint[] = [];

    for (let i = 0; i < numUsers; i++) {
      const snapBefore = await harness.snapshot(ctx);
      const expectedId = snapBefore.engine.nextAccountId;

      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "500000");

      const snapAfter = await harness.snapshot(ctx);

      // Find the new account (it should be the last one added)
      const newAccount = snapAfter.accounts.find(
        a => !snapBefore.accounts.some(b => b.account.accountId === a.account.accountId)
      );

      if (newAccount) {
        const assignedId = newAccount.account.accountId;
        accountIds.push(assignedId);

        TestHarness.assertBigIntEqual(
          assignedId,
          expectedId,
          `Account ${i} should get ID ${expectedId}`
        );
      }
    }

    console.log(`    IDs assigned: [${accountIds.join(", ")}]`);

    // Verify sequential
    for (let i = 1; i < accountIds.length; i++) {
      TestHarness.assert(
        accountIds[i] === accountIds[i - 1] + 1n,
        "IDs should be sequential"
      );
    }
  });

  // -------------------------------------------------------------------------
  // T9.4: Snapshot comparison
  // -------------------------------------------------------------------------
  await harness.runTest("T9.4: Snapshot comparison utility", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create some state
    for (let i = 0; i < 5; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "1000000");
    }

    const snap1 = await harness.snapshot(ctx);

    // Deposit more to one user
    const user0 = ctx.users.get("user0");
    if (user0) {
      await harness.deposit(ctx, user0, "500000");
    }

    const snap2 = await harness.snapshot(ctx);

    // Compare snapshots
    const results = InvariantChecker.compareSnapshots(snap1, snap2);

    console.log(`    Comparison results:`);
    for (const r of results) {
      console.log(`      ${r.name}: ${r.passed ? "match" : "differ"}`);
    }

    // Hash should differ (state changed)
    const hashResult = results.find(r => r.name === "D1: Hash equality");
    TestHarness.assert(
      hashResult && !hashResult.passed,
      "Hash should differ after deposit"
    );
  });

  // -------------------------------------------------------------------------
  // T9.5: Bitmap determinism
  // -------------------------------------------------------------------------
  await harness.runTest("T9.5: Bitmap consistency", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Add users and verify bitmap
    for (let i = 0; i < 8; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      await harness.initUser(ctx, user, "500000");

      const snap = await harness.snapshot(ctx);

      // Verify bitmap matches numUsedAccounts
      TestHarness.assertEqual(
        snap.usedIndices.length,
        snap.engine.numUsedAccounts,
        `Bitmap count should match numUsedAccounts at step ${i}`
      );
    }

    const finalSnap = await harness.snapshot(ctx);
    console.log(`    Final used indices: [${finalSnap.usedIndices.join(", ")}]`);
    console.log(`    numUsedAccounts: ${finalSnap.engine.numUsedAccounts}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T9 Summary: ${summary.passed}/${summary.total} passed`);
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

runT9Tests().catch(console.error);
export { runT9Tests };
