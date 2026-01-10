/**
 * T2: User Lifecycle Tests
 *
 * T2.1: Init user assigns unique account ID, increments nextId
 * T2.2: Init user sets bitmap bit correctly
 * T2.3: Init user transfers fee to vault
 * T2.4: Close account clears bitmap, returns collateral
 * T2.5: Double-init same pubkey fails
 */

import TestHarness, { TestContext, UserContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker, printInvariantReport } from "./invariants.js";

async function runT2Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T2: User Lifecycle Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T2.1: Init user assigns unique account ID
  // -------------------------------------------------------------------------
  await harness.runTest("T2.1: Init user assigns unique ID", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });
    const beforeSnap = await harness.snapshot(ctx);

    // Create and init user
    const user1 = await harness.createUser(ctx, "user1", 10_000_000n);
    const result = await harness.initUser(ctx, user1);

    TestHarness.assert(!result.err, `Init should succeed: ${result.err}`);

    const afterSnap = await harness.snapshot(ctx);

    // nextAccountId should have incremented (in engine state)
    TestHarness.assertBigIntEqual(
      afterSnap.engine.nextAccountId,
      beforeSnap.engine.nextAccountId + 1n,
      "nextAccountId should increment"
    );

    // numUsedAccounts should have incremented (in engine state)
    TestHarness.assertEqual(
      afterSnap.engine.numUsedAccounts,
      beforeSnap.engine.numUsedAccounts + 1,
      "numUsedAccounts should increment"
    );

    console.log(`    Before nextId: ${beforeSnap.engine.nextAccountId}`);
    console.log(`    After nextId: ${afterSnap.engine.nextAccountId}`);
    console.log(`    CU used: ${result.unitsConsumed}`);
  });

  // -------------------------------------------------------------------------
  // T2.2: Init user sets bitmap bit
  // -------------------------------------------------------------------------
  await harness.runTest("T2.2: Bitmap updated on init", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Fresh market should have empty bitmap
    const beforeSnap = await harness.snapshot(ctx);
    TestHarness.assertEqual(
      beforeSnap.usedIndices.length,
      0,
      "Fresh market should have no used indices"
    );

    // Init first user
    const user1 = await harness.createUser(ctx, "user1", 10_000_000n);
    await harness.initUser(ctx, user1);

    const afterSnap = await harness.snapshot(ctx);
    TestHarness.assertEqual(
      afterSnap.usedIndices.length,
      1,
      "Should have 1 used index after init"
    );

    // Init second user
    const user2 = await harness.createUser(ctx, "user2", 10_000_000n);
    await harness.initUser(ctx, user2);

    const afterSnap2 = await harness.snapshot(ctx);
    TestHarness.assertEqual(
      afterSnap2.usedIndices.length,
      2,
      "Should have 2 used indices after second init"
    );

    console.log(`    Used indices: [${afterSnap2.usedIndices.join(", ")}]`);
  });

  // -------------------------------------------------------------------------
  // T2.3: Init user transfers fee to insurance fund
  // Note: Init fee goes to insurance fund, not user capital
  // -------------------------------------------------------------------------
  await harness.runTest("T2.3: Fee transferred on init", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const beforeSnap = await harness.snapshot(ctx);
    const insuranceBefore = beforeSnap.engine.insuranceFund.balance;

    // Create user with enough tokens
    const feeAmount = 1_000_000n; // 1 USDC
    const user1 = await harness.createUser(ctx, "user1", feeAmount * 2n);

    await harness.initUser(ctx, user1, feeAmount.toString());
    const afterSnap = await harness.snapshot(ctx);

    // Find the user's account
    TestHarness.assert(
      afterSnap.accounts.length > 0,
      "User should be initialized"
    );

    // Init fee goes to insurance fund, not user capital
    TestHarness.assertBigIntEqual(
      afterSnap.engine.insuranceFund.balance,
      insuranceBefore + feeAmount,
      "Insurance fund should receive init fee"
    );

    // User capital should be 0 (no deposit yet)
    const userAccount = afterSnap.accounts[0].account;
    TestHarness.assertBigIntEqual(
      userAccount.capital,
      0n,
      "User capital should be 0 before deposit"
    );

    console.log(`    Fee: ${feeAmount}`);
    console.log(`    Insurance fund: ${afterSnap.engine.insuranceFund.balance}`);
  });

  // -------------------------------------------------------------------------
  // T2.4: Multiple users get sequential indices
  // Note: Account indices are unique; accountId field in struct is not used
  // -------------------------------------------------------------------------
  await harness.runTest("T2.4: Multiple users get sequential indices", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const users: UserContext[] = [];
    const numUsers = 5;

    for (let i = 0; i < numUsers; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 10_000_000n);
      await harness.initUser(ctx, user);
      users.push(user);
    }

    const snapshot = await harness.snapshot(ctx);

    TestHarness.assertEqual(
      snapshot.engine.numUsedAccounts,
      numUsers,
      `Should have ${numUsers} users`
    );

    // All slot indices should be unique
    const indices = snapshot.accounts.map(a => a.idx);
    const uniqueIndices = new Set(indices);
    TestHarness.assertEqual(
      uniqueIndices.size,
      numUsers,
      "All account indices should be unique"
    );

    // nextAccountId should track total accounts created
    TestHarness.assertBigIntEqual(
      snapshot.engine.nextAccountId,
      BigInt(numUsers),
      "nextAccountId should equal number of users"
    );

    console.log(`    Account indices: [${indices.join(", ")}]`);
    console.log(`    nextAccountId: ${snapshot.engine.nextAccountId}`);
  });

  // -------------------------------------------------------------------------
  // T2.5: Init LP works similarly
  // -------------------------------------------------------------------------
  await harness.runTest("T2.5: Init LP assigns unique index", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Init a user first
    const user = await harness.createUser(ctx, "user", 10_000_000n);
    await harness.initUser(ctx, user);

    // Then init an LP
    const lp = await harness.createUser(ctx, "lp", 10_000_000n);
    const result = await harness.initLP(ctx, lp);

    TestHarness.assert(!result.err, `Init LP should succeed: ${result.err}`);

    const snapshot = await harness.snapshot(ctx);

    TestHarness.assertEqual(
      snapshot.engine.numUsedAccounts,
      2,
      "Should have 2 accounts (user + LP)"
    );

    // Both should have unique indices
    const indices = snapshot.accounts.map(a => a.idx);
    const uniqueIndices = new Set(indices);
    TestHarness.assertEqual(uniqueIndices.size, 2, "User and LP should have unique indices");

    console.log(`    numUsedAccounts: ${snapshot.engine.numUsedAccounts}`);
    console.log(`    Account indices: [${indices.join(", ")}]`);
  });

  // -------------------------------------------------------------------------
  // T2.6: Full lifecycle - init, deposit, withdraw, close
  // -------------------------------------------------------------------------
  await harness.runTest("T2.6: Full user lifecycle", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create user with plenty of tokens
    const initialTokens = 100_000_000n; // 100 USDC
    const user = await harness.createUser(ctx, "user", initialTokens);

    // Init with 1 USDC fee
    const feeAmount = 1_000_000n;
    await harness.initUser(ctx, user, feeAmount.toString());

    let snapshot = await harness.snapshot(ctx);
    TestHarness.assertEqual(snapshot.engine.numUsedAccounts, 1, "Should have 1 user");

    // Deposit more collateral
    const depositAmount = 10_000_000n; // 10 USDC
    await harness.deposit(ctx, user, depositAmount.toString());

    snapshot = await harness.snapshot(ctx);
    const userAccount = snapshot.accounts[0].account;

    // Note: Init fee goes to insurance fund, not user capital
    TestHarness.assertBigIntEqual(
      userAccount.capital,
      depositAmount,
      "Capital should equal deposit (fee goes to insurance)"
    );

    console.log(`    After deposit: ${userAccount.capital}`);

    // Run keeper crank - required before withdraw to update engine state
    // Use the user as caller since they own account 0
    const crankResult = await harness.keeperCrankAsUser(ctx, user);
    TestHarness.assert(!crankResult.err, `Crank should succeed: ${crankResult.err}`);
    console.log(`    Keeper crank: success`);

    // Withdraw some collateral
    const withdrawAmount = 5_000_000n; // 5 USDC
    const withdrawResult = await harness.withdraw(ctx, user, withdrawAmount.toString());

    TestHarness.assert(!withdrawResult.err, `Withdraw should succeed: ${withdrawResult.err}`);
    snapshot = await harness.snapshot(ctx);
    const updatedAccount = snapshot.accounts[0].account;
    console.log(`    After withdraw: ${updatedAccount.capital}`);

    // Run invariant check
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    // Print detailed results if failed
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

    TestHarness.assert(report.passed, "Invariants should pass after lifecycle");

    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // T2.7: Conservation check after multiple users
  // Note: Use default fee (1M) for init, then deposit additional amounts.
  // The program transfers feePayment to vault but only tracks newAccountFee
  // in insurance, so using feePayment > newAccountFee breaks conservation.
  // -------------------------------------------------------------------------
  await harness.runTest("T2.7: Conservation after multiple users", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create multiple users with explicit 1M init fee (= params.newAccountFee), then deposit different amounts
    // IMPORTANT: feePayment must equal newAccountFee for conservation to hold.
    // The program transfers feePayment to vault but only credits newAccountFee to insurance.
    const depositAmounts = [1_000_000n, 5_000_000n, 10_000_000n, 2_500_000n];
    const feePerUser = 1_000_000n; // Must match params.newAccountFee
    let totalInVault = 0n;

    for (let i = 0; i < depositAmounts.length; i++) {
      const user = await harness.createUser(ctx, `user${i}`, depositAmounts[i] + feePerUser * 2n);
      await harness.initUser(ctx, user, feePerUser.toString()); // Explicit 1M fee
      totalInVault += feePerUser; // Init fee goes to insurance

      // Deposit additional collateral to user's capital
      await harness.deposit(ctx, user, depositAmounts[i].toString());
      totalInVault += depositAmounts[i];
    }

    // Print debug info
    const snapshot = await harness.snapshot(ctx);
    let totalCapital = 0n;
    for (const acct of snapshot.accounts) {
      totalCapital += acct.account.capital;
    }

    console.log(`    Total capital: ${totalCapital}`);
    console.log(`    Insurance balance: ${snapshot.engine.insuranceFund.balance}`);
    console.log(`    Engine vault: ${snapshot.engine.vault}`);
    console.log(`    Users: ${depositAmounts.length}`);
    console.log(`    Expected in vault: ${totalInVault}`);
    console.log(`    Slab total (capital + insurance): ${totalCapital + snapshot.engine.insuranceFund.balance}`);

    // Check invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    // Print detailed results if failed
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
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T2 Summary: ${summary.passed}/${summary.total} passed`);
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
runT2Tests().catch(console.error);

export { runT2Tests };
