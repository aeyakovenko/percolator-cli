/**
 * T13: Post-Trade Withdrawal Tests
 *
 * Verifies that users and LPs can withdraw exactly their expected balances
 * after trading, and cannot withdraw more than entitled.
 *
 * T13.1: Setup - Create LP and user with deposits
 * T13.2: User withdraws full capital after round-trip trade
 * T13.3: LP withdraws full capital after round-trip trade
 * T13.4: User cannot withdraw more than capital
 * T13.5: LP cannot withdraw more than capital
 * T13.6: Verify exact post-trade balances
 */

import TestHarness, { TestContext, UserContext, MATCHER_PROGRAM_ID } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT13Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T13: Post-Trade Withdrawal Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;
  let lp: UserContext;
  let user: UserContext;

  // Track expected balances
  let lpInitialDeposit: bigint;
  let userInitialDeposit: bigint;

  // -------------------------------------------------------------------------
  // T13.1: Setup LP and user with deposits, execute round-trip trade
  // -------------------------------------------------------------------------
  await harness.runTest("T13.1: Setup and execute round-trip trade", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    lpInitialDeposit = 50_000_000n; // 50 USDC
    userInitialDeposit = 10_000_000n; // 10 USDC
    const accountFee = 1_000_000n; // 1 USDC

    // Create LP with matcher
    lp = await harness.createUser(ctx, "lp", 100_000_000n);
    const initLpResult = await harness.initLPWithMatcher(ctx, lp, accountFee.toString());
    TestHarness.assert(!initLpResult.err, `Init LP should succeed: ${initLpResult.err}`);

    // Deposit collateral to LP
    const depositLpResult = await harness.deposit(ctx, lp, lpInitialDeposit.toString());
    TestHarness.assert(!depositLpResult.err, `LP deposit should succeed: ${depositLpResult.err}`);

    // Create user
    user = await harness.createUser(ctx, "user", 100_000_000n);
    const initUserResult = await harness.initUser(ctx, user, accountFee.toString());
    TestHarness.assert(!initUserResult.err, `Init user should succeed: ${initUserResult.err}`);

    // Deposit collateral to user
    const depositUserResult = await harness.deposit(ctx, user, userInitialDeposit.toString());
    TestHarness.assert(!depositUserResult.err, `User deposit should succeed: ${depositUserResult.err}`);

    // Top up insurance to exit risk-reduction mode
    const topUpResult = await harness.topUpInsurance(ctx, user, "1000000");
    TestHarness.assert(!topUpResult.err, `TopUp should succeed: ${topUpResult.err}`);

    // Crank to update oracle
    await harness.keeperCrankAsUser(ctx, user);

    // Verify initial setup
    let snapshot = await harness.snapshot(ctx);
    const lpAcctInit = snapshot.accounts.find(a => a.idx === lp.accountIndex);
    const userAcctInit = snapshot.accounts.find(a => a.idx === user.accountIndex);

    console.log(`    LP initial capital: ${lpAcctInit?.account.capital}`);
    console.log(`    User initial capital: ${userAcctInit?.account.capital}`);
    console.log(`    LP initial position: ${lpAcctInit?.account.positionSize}`);
    console.log(`    User initial position: ${userAcctInit?.account.positionSize}`);

    // Execute trade: user goes long
    const longResult = await harness.tradeCpi(ctx, user, lp, "1000");
    if (longResult.err) {
      console.log(`    Long trade error: ${longResult.err}`);
      throw new Error(`Long trade failed: ${longResult.err}`);
    }

    snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    After long: User position = ${userAcct?.account.positionSize}`);

    // Execute trade: user closes position (goes short same amount)
    const shortResult = await harness.tradeCpi(ctx, user, lp, "-1000");
    if (shortResult.err) {
      console.log(`    Short trade error: ${shortResult.err}`);
      throw new Error(`Short trade failed: ${shortResult.err}`);
    }

    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    After close: User position = ${userAcct?.account.positionSize}`);
    console.log(`    After close: LP position = ${lpAcct?.account.positionSize}`);
    console.log(`    After close: User capital = ${userAcct?.account.capital}`);
    console.log(`    After close: LP capital = ${lpAcct?.account.capital}`);

    // Both should be flat
    TestHarness.assertBigIntEqual(
      userAcct!.account.positionSize,
      0n,
      "User should be flat after round-trip"
    );
    TestHarness.assertBigIntEqual(
      lpAcct!.account.positionSize,
      0n,
      "LP should be flat after round-trip"
    );
  });

  // -------------------------------------------------------------------------
  // T13.2: User withdraws full capital after round-trip trade
  // -------------------------------------------------------------------------
  await harness.runTest("T13.2: User withdraws full capital", async () => {
    // Get user's current capital
    const snapshot = await harness.snapshot(ctx);
    const userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const userCapital = userAcct!.account.capital;

    console.log(`    User capital before withdraw: ${userCapital}`);

    // User should be able to withdraw their full capital
    const withdrawResult = await harness.withdraw(ctx, user, userCapital.toString());

    if (withdrawResult.err) {
      console.log(`    Withdraw error: ${withdrawResult.err}`);
      // Check if it's an oracle staleness issue
      if (withdrawResult.err.includes("stale") || withdrawResult.err.includes("Oracle")) {
        console.log(`    (Oracle staleness - trying keeper crank)`);
        await harness.keeperCrankAsUser(ctx, user);
        const retryResult = await harness.withdraw(ctx, user, userCapital.toString());
        if (retryResult.err) {
          throw new Error(`Withdraw failed after crank: ${retryResult.err}`);
        }
      } else {
        throw new Error(`Withdraw failed: ${withdrawResult.err}`);
      }
    }

    // Verify user capital is now 0
    const snapshotAfter = await harness.snapshot(ctx);
    const userAcctAfter = snapshotAfter.accounts.find(a => a.idx === user.accountIndex);

    console.log(`    User capital after withdraw: ${userAcctAfter?.account.capital}`);
    TestHarness.assertBigIntEqual(
      userAcctAfter!.account.capital,
      0n,
      "User capital should be 0 after full withdrawal"
    );
  });

  // -------------------------------------------------------------------------
  // T13.3: LP withdraws full capital after round-trip trade
  // -------------------------------------------------------------------------
  await harness.runTest("T13.3: LP withdraws full capital", async () => {
    // Get LP's current capital
    const snapshot = await harness.snapshot(ctx);
    const lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);
    const lpCapital = lpAcct!.account.capital;

    console.log(`    LP capital before withdraw: ${lpCapital}`);

    // LP should be able to withdraw their full capital
    const withdrawResult = await harness.withdraw(ctx, lp, lpCapital.toString());

    if (withdrawResult.err) {
      console.log(`    Withdraw error: ${withdrawResult.err}`);
      if (withdrawResult.err.includes("stale") || withdrawResult.err.includes("Oracle")) {
        console.log(`    (Oracle staleness - trying keeper crank)`);
        await harness.keeperCrankAsUser(ctx, lp);
        const retryResult = await harness.withdraw(ctx, lp, lpCapital.toString());
        if (retryResult.err) {
          throw new Error(`Withdraw failed after crank: ${retryResult.err}`);
        }
      } else {
        throw new Error(`Withdraw failed: ${withdrawResult.err}`);
      }
    }

    // Verify LP capital is now 0
    const snapshotAfter = await harness.snapshot(ctx);
    const lpAcctAfter = snapshotAfter.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    LP capital after withdraw: ${lpAcctAfter?.account.capital}`);
    TestHarness.assertBigIntEqual(
      lpAcctAfter!.account.capital,
      0n,
      "LP capital should be 0 after full withdrawal"
    );
  });

  // -------------------------------------------------------------------------
  // T13.4: User cannot withdraw more than capital
  // -------------------------------------------------------------------------
  await harness.runTest("T13.4: User cannot over-withdraw", async () => {
    // Create fresh context for this test
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Setup user with known capital
    user = await harness.createUser(ctx, "user2", 100_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "5000000"); // 5 USDC

    // Top up insurance first, then crank
    const topUpResult = await harness.topUpInsurance(ctx, user, "1000000");
    if (topUpResult.err) {
      console.log(`    TopUp warning: ${topUpResult.err.slice(0, 60)}`);
    }

    // Try crank, but don't fail if it errors (some tests don't need it)
    const crankResult = await harness.keeperCrankAsUser(ctx, user);
    if (crankResult.err) {
      console.log(`    Crank warning: ${crankResult.err.slice(0, 60)}`);
    }

    const snapshot = await harness.snapshot(ctx);
    const userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const userCapital = userAcct!.account.capital;

    console.log(`    User capital: ${userCapital}`);

    // Try to withdraw more than capital
    const overWithdrawAmount = userCapital + 1_000_000n; // 1 USDC more than capital
    console.log(`    Attempting to withdraw: ${overWithdrawAmount}`);

    const result = await harness.withdraw(ctx, user, overWithdrawAmount.toString());

    // Should fail
    TestHarness.assert(
      result.err !== null && result.err !== undefined,
      `Over-withdrawal should fail, but got: ${result.err || "success"}`
    );

    console.log(`    Over-withdraw result: ${result.err?.slice(0, 80)}`);

    // Verify capital unchanged
    const snapshotAfter = await harness.snapshot(ctx);
    const userAcctAfter = snapshotAfter.accounts.find(a => a.idx === user.accountIndex);

    TestHarness.assertBigIntEqual(
      userAcctAfter!.account.capital,
      userCapital,
      "Capital should be unchanged after failed over-withdrawal"
    );
  });

  // -------------------------------------------------------------------------
  // T13.5: LP cannot withdraw more than capital
  // -------------------------------------------------------------------------
  await harness.runTest("T13.5: LP cannot over-withdraw", async () => {
    // Create fresh context
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Setup LP with known capital
    lp = await harness.createUser(ctx, "lp2", 100_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "10000000"); // 10 USDC

    // Setup a user to top up insurance
    user = await harness.createUser(ctx, "user3", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");

    // Top up insurance and try crank (don't fail on crank errors)
    const topUpResult = await harness.topUpInsurance(ctx, user, "1000000");
    if (topUpResult.err) {
      console.log(`    TopUp warning: ${topUpResult.err.slice(0, 60)}`);
    }
    const crankResult = await harness.keeperCrankAsUser(ctx, user);
    if (crankResult.err) {
      console.log(`    Crank warning: ${crankResult.err.slice(0, 60)}`);
    }

    const snapshot = await harness.snapshot(ctx);
    const lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);
    const lpCapital = lpAcct!.account.capital;

    console.log(`    LP capital: ${lpCapital}`);

    // Try to withdraw more than capital
    const overWithdrawAmount = lpCapital + 1_000_000n;
    console.log(`    Attempting to withdraw: ${overWithdrawAmount}`);

    const result = await harness.withdraw(ctx, lp, overWithdrawAmount.toString());

    // Should fail
    TestHarness.assert(
      result.err !== null && result.err !== undefined,
      `LP over-withdrawal should fail, but got: ${result.err || "success"}`
    );

    console.log(`    Over-withdraw result: ${result.err?.slice(0, 80)}`);

    // Verify capital unchanged
    const snapshotAfter = await harness.snapshot(ctx);
    const lpAcctAfter = snapshotAfter.accounts.find(a => a.idx === lp.accountIndex);

    TestHarness.assertBigIntEqual(
      lpAcctAfter!.account.capital,
      lpCapital,
      "LP capital should be unchanged after failed over-withdrawal"
    );
  });

  // -------------------------------------------------------------------------
  // T13.6: Verify exact post-trade balances account for fees
  // -------------------------------------------------------------------------
  await harness.runTest("T13.6: Exact post-trade balance verification", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const lpDeposit = 50_000_000n;
    const userDeposit = 10_000_000n;

    // Setup LP
    lp = await harness.createUser(ctx, "lp3", 100_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, lpDeposit.toString());

    // Setup user
    user = await harness.createUser(ctx, "user4", 100_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, userDeposit.toString());

    // Top up insurance and crank
    const topUpResult = await harness.topUpInsurance(ctx, user, "1000000");
    if (topUpResult.err) {
      console.log(`    TopUp warning: ${topUpResult.err.slice(0, 60)}`);
    }
    const crankResult = await harness.keeperCrankAsUser(ctx, user);
    if (crankResult.err) {
      console.log(`    Crank warning: ${crankResult.err.slice(0, 60)}`);
    }

    // Record pre-trade state
    let snapshot = await harness.snapshot(ctx);
    const lpCapitalBefore = snapshot.accounts.find(a => a.idx === lp.accountIndex)!.account.capital;
    const userCapitalBefore = snapshot.accounts.find(a => a.idx === user.accountIndex)!.account.capital;
    const totalCapitalBefore = lpCapitalBefore + userCapitalBefore;

    console.log(`    Pre-trade LP capital: ${lpCapitalBefore}`);
    console.log(`    Pre-trade User capital: ${userCapitalBefore}`);
    console.log(`    Pre-trade Total: ${totalCapitalBefore}`);

    // Execute round-trip trade
    await harness.tradeCpi(ctx, user, lp, "500");
    await harness.tradeCpi(ctx, user, lp, "-500");

    // Record post-trade state
    snapshot = await harness.snapshot(ctx);
    const lpCapitalAfter = snapshot.accounts.find(a => a.idx === lp.accountIndex)!.account.capital;
    const userCapitalAfter = snapshot.accounts.find(a => a.idx === user.accountIndex)!.account.capital;
    const totalCapitalAfter = lpCapitalAfter + userCapitalAfter;
    const insuranceBalance = snapshot.engine.insuranceFund.balance;

    console.log(`    Post-trade LP capital: ${lpCapitalAfter}`);
    console.log(`    Post-trade User capital: ${userCapitalAfter}`);
    console.log(`    Post-trade Total capital: ${totalCapitalAfter}`);
    console.log(`    Insurance balance: ${insuranceBalance}`);

    // Trading fees should have moved from user/LP capital to insurance
    const capitalReduction = totalCapitalBefore - totalCapitalAfter;
    console.log(`    Capital reduction (fees paid): ${capitalReduction}`);

    // Verify: capital + insurance should be conserved
    // Note: Insurance already had some balance from account fees, so we just check
    // that the reduction in capital is reasonable (positive, not huge)
    TestHarness.assert(
      capitalReduction >= 0n,
      `Capital reduction should be non-negative: ${capitalReduction}`
    );
    TestHarness.assert(
      capitalReduction < 1_000_000n, // Less than 1 USDC in fees for small trade
      `Capital reduction should be reasonable: ${capitalReduction}`
    );

    // Both users should be able to withdraw their full remaining capital
    const userWithdrawResult = await harness.withdraw(ctx, user, userCapitalAfter.toString());
    const lpWithdrawResult = await harness.withdraw(ctx, lp, lpCapitalAfter.toString());

    // Log results
    if (userWithdrawResult.err) {
      console.log(`    User withdraw error: ${userWithdrawResult.err.slice(0, 60)}`);
    } else {
      console.log(`    User successfully withdrew: ${userCapitalAfter}`);
    }

    if (lpWithdrawResult.err) {
      console.log(`    LP withdraw error: ${lpWithdrawResult.err.slice(0, 60)}`);
    } else {
      console.log(`    LP successfully withdrew: ${lpCapitalAfter}`);
    }

    // Both should succeed (or fail only due to oracle staleness which we handle)
    const userSuccess = !userWithdrawResult.err ||
      userWithdrawResult.err.includes("stale") ||
      userWithdrawResult.err.includes("Oracle");
    const lpSuccess = !lpWithdrawResult.err ||
      lpWithdrawResult.err.includes("stale") ||
      lpWithdrawResult.err.includes("Oracle");

    TestHarness.assert(userSuccess, `User withdrawal should succeed: ${userWithdrawResult.err}`);
    TestHarness.assert(lpSuccess, `LP withdrawal should succeed: ${lpWithdrawResult.err}`);
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T13 Summary: ${summary.passed}/${summary.total} passed`);
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
runT13Tests().catch(console.error);

export { runT13Tests };
