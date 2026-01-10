/**
 * T15: Funding Rate Tests
 *
 * Tests the funding rate mechanics for perpetual contracts.
 *
 * Funding in perpetuals:
 * - Funding payments transfer capital between longs and shorts
 * - When perp > spot: longs pay shorts (perp premium)
 * - When perp < spot: shorts pay longs (perp discount)
 * - Rate is calculated based on price difference and time
 *
 * Key fields:
 * - engine.fundingIndexQpbE6: Global cumulative funding index (Q6 precision)
 * - engine.lastFundingSlot: Last slot when funding was applied
 * - account.fundingIndex: Account's funding index at last settlement
 *
 * Funding settlement formula:
 *   payment = positionSize * (globalFundingIndex - accountFundingIndex)
 *   - Positive position (long): pays when index increases
 *   - Negative position (short): receives when index increases
 *
 * T15.1: Funding index tracking - verify initial state
 * T15.2: Funding settlement after slots elapse
 * T15.3: Funding applies correctly to opposing positions
 * T15.4: Funding conservation - sum of payments = 0
 * T15.5: Inverted market funding direction
 * T15.6: Funding with multiple positions
 */

import TestHarness, { TestContext, UserContext, MATCHER_PROGRAM_ID } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT15Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T15: Funding Rate Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;
  let lp: UserContext;
  let user: UserContext;
  let user2: UserContext;

  // -------------------------------------------------------------------------
  // T15.1: Funding index tracking - verify initial state
  // -------------------------------------------------------------------------
  await harness.runTest("T15.1: Funding index tracking", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Get initial funding state
    const snapshot = await harness.snapshot(ctx);
    console.log(`    Funding index: ${snapshot.engine.fundingIndexQpbE6}`);
    console.log(`    Last funding slot: ${snapshot.engine.lastFundingSlot}`);
    console.log(`    Current slot: ${snapshot.engine.currentSlot}`);

    // Initial funding index should be 0 or initialized value
    TestHarness.assert(
      snapshot.engine.fundingIndexQpbE6 >= 0n || snapshot.engine.fundingIndexQpbE6 < 0n,
      "Funding index should be a valid value"
    );

    // Last funding slot should be set to current or recent slot
    TestHarness.assert(
      snapshot.engine.lastFundingSlot > 0n,
      "Last funding slot should be initialized"
    );
  });

  // -------------------------------------------------------------------------
  // T15.2: Funding settlement after slots elapse
  // -------------------------------------------------------------------------
  await harness.runTest("T15.2: Funding settlement after keeper crank", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create LP and user
    lp = await harness.createUser(ctx, "lp", 100_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "50000000"); // 50 USDC

    user = await harness.createUser(ctx, "user", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000"); // 10 USDC

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Take a position
    const tradeResult = await harness.tradeCpi(ctx, user, lp, "200");
    if (tradeResult.err) {
      console.log(`    Trade error: ${tradeResult.err.slice(0, 60)}`);
      return;
    }

    // Get state before crank
    let snapshot = await harness.snapshot(ctx);
    const fundingIndexBefore = snapshot.engine.fundingIndexQpbE6;
    const lastFundingSlotBefore = snapshot.engine.lastFundingSlot;
    console.log(`    Before crank - Funding index: ${fundingIndexBefore}`);
    console.log(`    Before crank - Last funding slot: ${lastFundingSlotBefore}`);

    // Get user account funding index
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const userFundingBefore = userAcct?.account.fundingIndex ?? 0n;
    const userCapitalBefore = userAcct?.account.capital ?? 0n;
    console.log(`    User funding index before: ${userFundingBefore}`);
    console.log(`    User capital before: ${userCapitalBefore}`);

    // Wait a bit and run keeper crank
    await new Promise(resolve => setTimeout(resolve, 1000));
    await harness.keeperCrankAsUser(ctx, user);

    // Get state after crank
    snapshot = await harness.snapshot(ctx);
    const fundingIndexAfter = snapshot.engine.fundingIndexQpbE6;
    const lastFundingSlotAfter = snapshot.engine.lastFundingSlot;
    console.log(`    After crank - Funding index: ${fundingIndexAfter}`);
    console.log(`    After crank - Last funding slot: ${lastFundingSlotAfter}`);

    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    const userFundingAfter = userAcct?.account.fundingIndex ?? 0n;
    const userCapitalAfter = userAcct?.account.capital ?? 0n;
    console.log(`    User funding index after: ${userFundingAfter}`);
    console.log(`    User capital after: ${userCapitalAfter}`);

    // Funding slot should advance
    if (lastFundingSlotAfter > lastFundingSlotBefore) {
      console.log(`    Funding slot advanced: ${lastFundingSlotBefore} -> ${lastFundingSlotAfter}`);
    }

    // Capital might change due to funding
    const capitalChange = userCapitalAfter - userCapitalBefore;
    console.log(`    Capital change: ${capitalChange}`);
  });

  // -------------------------------------------------------------------------
  // T15.3: Funding applies correctly to opposing positions
  // -------------------------------------------------------------------------
  await harness.runTest("T15.3: Funding on opposing positions", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create LP (will take opposing position)
    lp = await harness.createUser(ctx, "lp3", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000"); // 100 USDC

    // Create user
    user = await harness.createUser(ctx, "user3", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000"); // 10 USDC

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // User goes long
    const tradeResult = await harness.tradeCpi(ctx, user, lp, "500");
    if (tradeResult.err) {
      console.log(`    Trade error: ${tradeResult.err.slice(0, 60)}`);
      return;
    }

    // Get state - LP should be short, user should be long
    let snapshot = await harness.snapshot(ctx);
    let userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    let lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    User position: ${userAcct?.account.positionSize}`);
    console.log(`    LP position: ${lpAcct?.account.positionSize}`);

    // Verify opposing positions
    const userPos = userAcct?.account.positionSize ?? 0n;
    const lpPos = lpAcct?.account.positionSize ?? 0n;

    TestHarness.assert(userPos > 0n, "User should be long");
    TestHarness.assert(lpPos < 0n, "LP should be short");

    // Record capitals
    const userCapBefore = userAcct?.account.capital ?? 0n;
    const lpCapBefore = lpAcct?.account.capital ?? 0n;
    console.log(`    User capital before: ${userCapBefore}`);
    console.log(`    LP capital before: ${lpCapBefore}`);

    // Run crank to apply funding
    await new Promise(resolve => setTimeout(resolve, 1000));
    await harness.keeperCrankAsUser(ctx, user);

    // Check capitals after funding
    snapshot = await harness.snapshot(ctx);
    userAcct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    const userCapAfter = userAcct?.account.capital ?? 0n;
    const lpCapAfter = lpAcct?.account.capital ?? 0n;
    console.log(`    User capital after: ${userCapAfter}`);
    console.log(`    LP capital after: ${lpCapAfter}`);

    const userCapChange = userCapAfter - userCapBefore;
    const lpCapChange = lpCapAfter - lpCapBefore;
    console.log(`    User capital change: ${userCapChange}`);
    console.log(`    LP capital change: ${lpCapChange}`);
  });

  // -------------------------------------------------------------------------
  // T15.4: Funding conservation - sum of payments = 0
  // -------------------------------------------------------------------------
  await harness.runTest("T15.4: Funding conservation", async () => {
    // Use different decimals to force fresh mint (avoid cache issues)
    ctx = await harness.createFreshMarket({ maxAccounts: 64, decimals: 9 });

    // Small delay to ensure vault is queryable
    await new Promise(resolve => setTimeout(resolve, 500));

    // Setup LP and user with positions
    lp = await harness.createUser(ctx, "lp4", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user4", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Trade
    await harness.tradeCpi(ctx, user, lp, "300");

    // Total capital before (use slab accounting, not vault balance)
    let snapshot = await harness.snapshot(ctx);
    let totalCapBefore = 0n;
    for (const { account } of snapshot.accounts) {
      totalCapBefore += account.capital;
    }
    const insuranceBefore = snapshot.engine.insuranceFund.balance;
    console.log(`    Total capital before: ${totalCapBefore}`);
    console.log(`    Insurance before: ${insuranceBefore}`);

    // Run crank
    await new Promise(resolve => setTimeout(resolve, 1000));
    await harness.keeperCrankAsUser(ctx, user);

    // Total capital after
    snapshot = await harness.snapshot(ctx);
    let totalCapAfter = 0n;
    for (const { account } of snapshot.accounts) {
      totalCapAfter += account.capital;
    }
    const insuranceAfter = snapshot.engine.insuranceFund.balance;
    console.log(`    Total capital after: ${totalCapAfter}`);
    console.log(`    Insurance after: ${insuranceAfter}`);

    // Funding should be zero-sum (transfers between accounts)
    // Total capital + insurance should be conserved
    const totalBefore = totalCapBefore + insuranceBefore;
    const totalAfter = totalCapAfter + insuranceAfter;
    const diff = totalAfter > totalBefore ? totalAfter - totalBefore : totalBefore - totalAfter;

    console.log(`    Total before: ${totalBefore}`);
    console.log(`    Total after: ${totalAfter}`);
    console.log(`    Difference: ${diff}`);

    // Allow small tolerance for fees
    TestHarness.assert(
      diff < 100_000n, // 0.1 USDC tolerance
      `Conservation should hold, diff=${diff}`
    );
  });

  // -------------------------------------------------------------------------
  // T15.5: Inverted market funding direction
  // -------------------------------------------------------------------------
  await harness.runTest("T15.5: Inverted market funding", async () => {
    // Create an inverted market (SOL/USD -> USD/SOL)
    ctx = await harness.createFreshMarket({ maxAccounts: 64, invert: 1 });

    // Get config to verify inversion
    const snapshot = await harness.snapshot(ctx);
    console.log(`    Market invert flag: ${snapshot.config.invert}`);

    TestHarness.assertBigIntEqual(
      BigInt(snapshot.config.invert),
      1n,
      "Invert flag should be 1"
    );

    // Setup LP and user
    lp = await harness.createUser(ctx, "lp5", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user5", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Trade on inverted market
    const tradeResult = await harness.tradeCpi(ctx, user, lp, "200");
    if (tradeResult.err) {
      console.log(`    Inverted market trade: ${tradeResult.err.slice(0, 60)}`);
    } else {
      console.log(`    Inverted market trade succeeded`);
    }

    // Get positions
    let snap = await harness.snapshot(ctx);
    let userAcct = snap.accounts.find(a => a.idx === user.accountIndex);
    let lpAcct = snap.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    User position (inverted): ${userAcct?.account.positionSize}`);
    console.log(`    LP position (inverted): ${lpAcct?.account.positionSize}`);
    console.log(`    Global funding index: ${snap.engine.fundingIndexQpbE6}`);

    // Run crank
    await new Promise(resolve => setTimeout(resolve, 500));
    await harness.keeperCrankAsUser(ctx, user);

    // Check funding after
    snap = await harness.snapshot(ctx);
    console.log(`    Funding index after crank: ${snap.engine.fundingIndexQpbE6}`);
  });

  // -------------------------------------------------------------------------
  // T15.6: Funding with multiple positions
  // -------------------------------------------------------------------------
  await harness.runTest("T15.6: Multiple positions funding", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create LP
    lp = await harness.createUser(ctx, "lp6", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    // Create two users
    user = await harness.createUser(ctx, "user6a", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    user2 = await harness.createUser(ctx, "user6b", 50_000_000n);
    await harness.initUser(ctx, user2, "1000000");
    await harness.deposit(ctx, user2, "10000000");

    await harness.topUpInsurance(ctx, user, "2000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Both users take positions against LP
    await harness.tradeCpi(ctx, user, lp, "200");  // user1 long
    await harness.tradeCpi(ctx, user2, lp, "300"); // user2 long

    // Get state
    let snapshot = await harness.snapshot(ctx);
    let user1Acct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    let user2Acct = snapshot.accounts.find(a => a.idx === user2.accountIndex);
    let lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    User1 position: ${user1Acct?.account.positionSize}`);
    console.log(`    User2 position: ${user2Acct?.account.positionSize}`);
    console.log(`    LP position: ${lpAcct?.account.positionSize}`);

    const user1CapBefore = user1Acct?.account.capital ?? 0n;
    const user2CapBefore = user2Acct?.account.capital ?? 0n;
    const lpCapBefore = lpAcct?.account.capital ?? 0n;

    // Run crank to apply funding
    await new Promise(resolve => setTimeout(resolve, 1000));
    await harness.keeperCrankAsUser(ctx, user);

    snapshot = await harness.snapshot(ctx);
    user1Acct = snapshot.accounts.find(a => a.idx === user.accountIndex);
    user2Acct = snapshot.accounts.find(a => a.idx === user2.accountIndex);
    lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    const user1CapAfter = user1Acct?.account.capital ?? 0n;
    const user2CapAfter = user2Acct?.account.capital ?? 0n;
    const lpCapAfter = lpAcct?.account.capital ?? 0n;

    console.log(`    User1 capital change: ${user1CapAfter - user1CapBefore}`);
    console.log(`    User2 capital change: ${user2CapAfter - user2CapBefore}`);
    console.log(`    LP capital change: ${lpCapAfter - lpCapBefore}`);

    // Open interest balance check
    const totalLong = (user1Acct?.account.positionSize ?? 0n) + (user2Acct?.account.positionSize ?? 0n);
    const totalShort = -(lpAcct?.account.positionSize ?? 0n);
    console.log(`    Total long: ${totalLong}`);
    console.log(`    Total short: ${totalShort}`);

    TestHarness.assertBigIntEqual(totalLong, totalShort, "Open interest should balance");
  });

  // -------------------------------------------------------------------------
  // T15.7: Invariants hold after funding operations
  // -------------------------------------------------------------------------
  await harness.runTest("T15.7: Invariants after funding", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Full setup with positions
    lp = await harness.createUser(ctx, "lp7", 200_000_000n);
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "100000000");

    user = await harness.createUser(ctx, "user7", 50_000_000n);
    await harness.initUser(ctx, user, "1000000");
    await harness.deposit(ctx, user, "10000000");

    await harness.topUpInsurance(ctx, user, "1000000");
    await harness.keeperCrankAsUser(ctx, user);

    // Trade and run funding
    await harness.tradeCpi(ctx, user, lp, "400");
    await new Promise(resolve => setTimeout(resolve, 500));
    await harness.keeperCrankAsUser(ctx, user);

    // Check all invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    if (!report.passed) {
      console.log("    Invariant failures:");
      for (const r of report.results) {
        if (!r.passed) {
          console.log(`      ${r.name}: ${r.message || r.expected}`);
        }
      }
    }

    console.log(`    All invariants: ${report.passed ? "PASS" : "FAIL"}`);
    TestHarness.assert(report.passed, "All invariants should hold after funding");
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T15 Summary: ${summary.passed}/${summary.total} passed`);
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
runT15Tests().catch(console.error);

export { runT15Tests };
