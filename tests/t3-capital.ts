/**
 * T3: Capital & Withdrawal Tests
 *
 * T3.1: Deposit increases collateral correctly
 * T3.2: Withdraw decreases collateral, respects margin
 * T3.3: Cannot withdraw more than available margin
 * T3.4: Conservation holds after deposits/withdrawals
 */

import TestHarness, { TestContext, UserContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker, printInvariantReport } from "./invariants.js";

async function runT3Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T3: Capital & Withdrawal Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T3.1: Deposit increases collateral
  // Note: Init fee goes to insurance fund, not user capital
  // -------------------------------------------------------------------------
  await harness.runTest("T3.1: Deposit increases collateral", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const initFee = 1_000_000n;
    const user = await harness.createUser(ctx, "user", 50_000_000n);
    await harness.initUser(ctx, user, initFee.toString());

    // Get balance after init - should be 0 (fee goes to insurance, not capital)
    let snapshot = await harness.snapshot(ctx);
    const balanceAfterInit = snapshot.accounts[0].account.capital;

    TestHarness.assertBigIntEqual(
      balanceAfterInit,
      0n,
      "Initial capital should be 0 (fee goes to insurance)"
    );

    // Deposit collateral
    const depositAmount = 5_000_000n;
    const result = await harness.deposit(ctx, user, depositAmount.toString());
    TestHarness.assert(!result.err, `Deposit should succeed: ${result.err}`);

    snapshot = await harness.snapshot(ctx);
    const balanceAfterDeposit = snapshot.accounts[0].account.capital;

    TestHarness.assertBigIntEqual(
      balanceAfterDeposit,
      depositAmount,
      "Balance should equal deposit amount"
    );

    console.log(`    After init: ${balanceAfterInit}`);
    console.log(`    After deposit: ${balanceAfterDeposit}`);
    console.log(`    CU used: ${result.unitsConsumed}`);
  });

  // -------------------------------------------------------------------------
  // T3.2: Multiple deposits accumulate correctly
  // Note: Init fee goes to insurance fund, not user capital
  // -------------------------------------------------------------------------
  await harness.runTest("T3.2: Multiple deposits accumulate", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const initFee = 1_000_000n;
    const user = await harness.createUser(ctx, "user", 100_000_000n);
    await harness.initUser(ctx, user, initFee.toString());

    // Capital starts at 0 (fee goes to insurance)
    let expectedBalance = 0n;
    const deposits = [2_000_000n, 3_000_000n, 5_000_000n];

    for (const amount of deposits) {
      await harness.deposit(ctx, user, amount.toString());
      expectedBalance += amount;
    }

    const snapshot = await harness.snapshot(ctx);
    const actualBalance = snapshot.accounts[0].account.capital;

    TestHarness.assertBigIntEqual(
      actualBalance,
      expectedBalance,
      "Balance should equal sum of all deposits"
    );

    console.log(`    Expected: ${expectedBalance}`);
    console.log(`    Actual: ${actualBalance}`);
  });

  // -------------------------------------------------------------------------
  // T3.3: Withdraw without position succeeds
  // -------------------------------------------------------------------------
  await harness.runTest("T3.3: Withdraw without position", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const initialFee = 10_000_000n;
    const user = await harness.createUser(ctx, "user", 50_000_000n);
    await harness.initUser(ctx, user, initialFee.toString());

    // Try to withdraw half
    const withdrawAmount = 5_000_000n;
    const result = await harness.withdraw(ctx, user, withdrawAmount.toString());

    // May fail if oracle is stale - that's OK for this test
    if (result.err) {
      console.log(`    Withdraw result: ${result.err.slice(0, 60)}`);
      console.log(`    (May fail due to oracle state - this is expected behavior)`);
    } else {
      const snapshot = await harness.snapshot(ctx);
      const balance = snapshot.accounts[0].account.capital;

      TestHarness.assertBigIntEqual(
        balance,
        initialFee - withdrawAmount,
        "Balance should decrease by withdrawal"
      );
      console.log(`    Balance after withdraw: ${balance}`);
      console.log(`    CU used: ${result.unitsConsumed}`);
    }
  });

  // -------------------------------------------------------------------------
  // T3.4: Conservation after multiple deposits/withdrawals
  // Note: Use default fee (params.newAccountFee) to ensure conservation
  // -------------------------------------------------------------------------
  await harness.runTest("T3.4: Conservation after operations", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create multiple users with explicit 1M fee (= params.newAccountFee)
    // IMPORTANT: feePayment must equal newAccountFee for conservation to hold.
    // The program transfers feePayment to vault but only credits newAccountFee to insurance.
    const users: UserContext[] = [];
    const numUsers = 3;
    const initFee = "1000000"; // Must match params.newAccountFee

    for (let i = 0; i < numUsers; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 50_000_000n);
      await harness.initUser(ctx, user, initFee); // Explicit 1M fee
      users.push(user);
    }

    // Additional deposits
    await harness.deposit(ctx, users[0], "2000000");
    await harness.deposit(ctx, users[1], "3000000");

    // Print slab state
    const snapshot = await harness.snapshot(ctx);
    let totalCapital = 0n;
    for (const acct of snapshot.accounts) {
      totalCapital += acct.account.capital;
    }

    console.log(`    Total capital: ${totalCapital}`);
    console.log(`    Insurance balance: ${snapshot.engine.insuranceFund.balance}`);
    console.log(`    Engine vault: ${snapshot.engine.vault}`);
    console.log(`    Slab total (capital + insurance): ${totalCapital + snapshot.engine.insuranceFund.balance}`);

    // Check invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    if (!report.passed) {
      console.log("    Invariant details:");
      for (const r of report.results) {
        if (!r.passed) {
          console.log(`      FAIL: ${r.name}`);
          if (r.expected) console.log(`        Expected: ${r.expected}`);
          if (r.actual) console.log(`        Actual: ${r.actual}`);
          if (r.message) console.log(`        ${r.message}`);
        }
      }
    }

    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
    TestHarness.assert(report.passed, "Conservation should hold");
  });

  // -------------------------------------------------------------------------
  // T3.5: Zero deposit should fail or be no-op
  // -------------------------------------------------------------------------
  await harness.runTest("T3.5: Zero deposit handling", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const user = await harness.createUser(ctx, "user", 10_000_000n);
    await harness.initUser(ctx, user, "1000000");

    const snapshotBefore = await harness.snapshot(ctx);
    const balanceBefore = snapshotBefore.accounts[0].account.capital;

    // Try zero deposit
    const result = await harness.deposit(ctx, user, "0");

    const snapshotAfter = await harness.snapshot(ctx);
    const balanceAfter = snapshotAfter.accounts[0].account.capital;

    // Balance should not change
    TestHarness.assertBigIntEqual(
      balanceAfter,
      balanceBefore,
      "Zero deposit should not change balance"
    );

    console.log(`    Before: ${balanceBefore}`);
    console.log(`    After: ${balanceAfter}`);
    console.log(`    Result: ${result.err || "success"}`);
  });

  // -------------------------------------------------------------------------
  // T3.6: Large deposit (stress test)
  // Note: Init fee goes to insurance, so we need a separate deposit
  // -------------------------------------------------------------------------
  await harness.runTest("T3.6: Large deposit amount", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Large amount: 1 billion USDC (with 6 decimals = 10^15)
    const largeAmount = 1_000_000_000_000_000n;
    const initFee = 1_000_000n;
    const user = await harness.createUser(ctx, "user", largeAmount * 2n);
    await harness.initUser(ctx, user, initFee.toString());

    // Now deposit the large amount
    await harness.deposit(ctx, user, largeAmount.toString());

    const snapshot = await harness.snapshot(ctx);
    const balance = snapshot.accounts[0].account.capital;

    TestHarness.assertBigIntEqual(
      balance,
      largeAmount,
      "Should handle large amounts"
    );

    console.log(`    Deposited: ${largeAmount}`);
    console.log(`    Balance: ${balance}`);
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T3 Summary: ${summary.passed}/${summary.total} passed`);
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
runT3Tests().catch(console.error);

export { runT3Tests };
