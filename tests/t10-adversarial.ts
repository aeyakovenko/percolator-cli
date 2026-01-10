/**
 * T10: Adversarial Tests
 *
 * T10.1: Invalid instruction data handling
 * T10.2: Wrong account ordering
 * T10.3: Unauthorized access attempts
 * T10.4: Edge case values
 */

import TestHarness, { TestContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildIx } from "../src/runtime/tx.js";
import {
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
  WELL_KNOWN,
} from "../src/abi/accounts.js";
import { encodeInitUser, encodeDeposit } from "../src/abi/instructions.js";

async function runT10Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T10: Adversarial Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T10.1: Double initialization
  // -------------------------------------------------------------------------
  await harness.runTest("T10.1: Double init same user", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const user = await harness.createUser(ctx, "user", 10_000_000n);

    // First init should succeed
    const result1 = await harness.initUser(ctx, user, "1000000");
    TestHarness.assert(!result1.err, `First init should succeed: ${result1.err}`);

    // Second init with same keypair should fail
    const result2 = await harness.initUser(ctx, user, "1000000");

    // Should fail (duplicate pubkey)
    console.log(`    First init: ${result1.err || "success"}`);
    console.log(`    Second init: ${result2.err || "unexpected success"}`);

    // Verify only one account exists
    const snapshot = await harness.snapshot(ctx);
    TestHarness.assertEqual(
      snapshot.engine.numUsedAccounts,
      1,
      "Should only have 1 account"
    );
  });

  // -------------------------------------------------------------------------
  // T10.2: Deposit to non-existent account
  // -------------------------------------------------------------------------
  await harness.runTest("T10.2: Deposit to non-existent account", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create user but don't init
    const user = await harness.createUser(ctx, "user", 10_000_000n);

    // Try to deposit without init
    const result = await harness.deposit(ctx, user, "1000000");

    // Should fail
    TestHarness.assert(!!result.err, "Deposit to non-existent account should fail");
    console.log(`    Result: ${result.err?.slice(0, 60)}`);
  });

  // -------------------------------------------------------------------------
  // T10.3: Withdraw more than balance
  // -------------------------------------------------------------------------
  await harness.runTest("T10.3: Withdraw more than balance", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const depositAmount = 1_000_000n;
    const user = await harness.createUser(ctx, "user", 10_000_000n);
    await harness.initUser(ctx, user, depositAmount.toString());

    // Try to withdraw 10x the balance
    const withdrawAmount = depositAmount * 10n;
    const result = await harness.withdraw(ctx, user, withdrawAmount.toString());

    console.log(`    Balance: ${depositAmount}`);
    console.log(`    Attempted withdraw: ${withdrawAmount}`);
    console.log(`    Result: ${result.err?.slice(0, 60) || "unexpectedly allowed"}`);
  });

  // -------------------------------------------------------------------------
  // T10.4: Max accounts limit
  // -------------------------------------------------------------------------
  await harness.runTest("T10.4: Max accounts limit", async () => {
    const maxAccounts = 8; // Small limit for testing
    ctx = await harness.createFreshMarket({ maxAccounts });

    // Fill all slots
    for (let i = 0; i < maxAccounts; i++) {
      const user = await harness.createUser(ctx, `user${i}`, 5_000_000n);
      const result = await harness.initUser(ctx, user, "500000");
      TestHarness.assert(!result.err, `Init ${i} should succeed: ${result.err}`);
    }

    // Try to add one more
    const extraUser = await harness.createUser(ctx, "extra", 5_000_000n);
    const result = await harness.initUser(ctx, extraUser, "500000");

    // Should fail (market full)
    TestHarness.assert(!!result.err, "Should reject when market is full");
    console.log(`    Max accounts: ${maxAccounts}`);
    console.log(`    Extra user result: ${result.err?.slice(0, 60)}`);

    const snapshot = await harness.snapshot(ctx);
    TestHarness.assertEqual(
      snapshot.engine.numUsedAccounts,
      maxAccounts,
      "Should have exactly maxAccounts users"
    );
  });

  // -------------------------------------------------------------------------
  // T10.5: Zero fee payment
  // -------------------------------------------------------------------------
  await harness.runTest("T10.5: Zero fee payment", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const user = await harness.createUser(ctx, "user", 10_000_000n);

    // Try init with zero fee
    const result = await harness.initUser(ctx, user, "0");

    console.log(`    Zero fee result: ${result.err?.slice(0, 60) || "allowed"}`);

    if (!result.err) {
      const snapshot = await harness.snapshot(ctx);
      const balance = snapshot.accounts[0]?.account.capital ?? 0n;
      console.log(`    User balance: ${balance}`);
    }
  });

  // -------------------------------------------------------------------------
  // T10.6: Large number handling
  // -------------------------------------------------------------------------
  await harness.runTest("T10.6: Large number handling", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Try with u64 max (2^64 - 1)
    const maxU64 = "18446744073709551615";
    const user = await harness.createUser(ctx, "user", BigInt(maxU64));

    // Init with large amount should fail (insufficient tokens)
    const result = await harness.initUser(ctx, user, maxU64);

    console.log(`    Max u64 fee: ${result.err?.slice(0, 60) || "allowed"}`);
  });

  // -------------------------------------------------------------------------
  // T10.7: Invariants after adversarial tests
  // -------------------------------------------------------------------------
  await harness.runTest("T10.7: Invariants after adversarial ops", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Do various operations
    const user1 = await harness.createUser(ctx, "user1", 20_000_000n);
    await harness.initUser(ctx, user1, "5000000");

    const user2 = await harness.createUser(ctx, "user2", 20_000_000n);
    await harness.initUser(ctx, user2, "5000000");

    // Some deposits
    await harness.deposit(ctx, user1, "2000000");
    await harness.deposit(ctx, user2, "3000000");

    // Try invalid operations (should fail gracefully)
    await harness.withdraw(ctx, user1, "999999999999"); // Too much
    await harness.initUser(ctx, user1, "1000000"); // Double init

    // Invariants should still hold
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    TestHarness.assert(report.passed, "Invariants should hold after adversarial ops");
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T10 Summary: ${summary.passed}/${summary.total} passed`);
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

runT10Tests().catch(console.error);
export { runT10Tests };
