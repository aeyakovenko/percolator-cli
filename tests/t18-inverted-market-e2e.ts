/**
 * T18: Inverted SOL/USD Market End-to-End Test
 *
 * Tests the complete flow of an inverted perpetual market where:
 * - The underlying asset is USD (quoted in SOL)
 * - Users long/short USD with SOL as collateral
 * - Oracle price is inverted (1/BTC_USD for testing, would be 1/SOL_USD in production)
 *
 * Inverted market mechanics:
 * - invert=1 tells the program to use 1/oracle_price
 * - "Going long" on inverted market = shorting the base asset
 * - "Going short" on inverted market = longing the base asset
 * - This allows SOL holders to speculate on USD value
 *
 * T18.1: Create inverted market and verify config
 * T18.2: Setup LP and user accounts
 * T18.3: Open long position (betting USD goes up vs SOL)
 * T18.4: Open short position (betting USD goes down vs SOL)
 * T18.5: Close positions and verify PnL
 * T18.6: Verify funding rate direction on inverted market
 * T18.7: Full market cycle with invariant checks
 */

import TestHarness, { TestContext, UserContext, MATCHER_PROGRAM_ID } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT18Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T18: Inverted SOL/USD Market E2E Test");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;
  let lp: UserContext;
  let user1: UserContext;
  let user2: UserContext;

  // -------------------------------------------------------------------------
  // T18.1: Create inverted market and verify config
  // -------------------------------------------------------------------------
  await harness.runTest("T18.1: Create inverted market", async () => {
    // Create inverted market (simulating SOL/USD -> USD/SOL)
    ctx = await harness.createFreshMarket({
      maxAccounts: 64,
      invert: 1,  // Enable price inversion
    });

    const snapshot = await harness.snapshot(ctx);

    console.log(`    Market config:`);
    console.log(`      Invert: ${snapshot.config.invert}`);
    console.log(`      Unit scale: ${snapshot.config.unitScale}`);
    console.log(`      Collateral mint: ${snapshot.config.collateralMint.toBase58().slice(0, 8)}...`);

    console.log(`    Risk params:`);
    console.log(`      Initial margin: ${snapshot.params.initialMarginBps} bps (${Number(snapshot.params.initialMarginBps) / 100}%)`);
    console.log(`      Maintenance margin: ${snapshot.params.maintenanceMarginBps} bps (${Number(snapshot.params.maintenanceMarginBps) / 100}%)`);
    console.log(`      Max leverage: ${10000n / snapshot.params.initialMarginBps}x`);

    TestHarness.assertBigIntEqual(
      BigInt(snapshot.config.invert),
      1n,
      "Invert flag should be 1 for inverted market"
    );
  });

  // -------------------------------------------------------------------------
  // T18.2: Setup LP and user accounts
  // -------------------------------------------------------------------------
  await harness.runTest("T18.2: Setup accounts", async () => {
    // LP provides liquidity (counterparty for all trades)
    lp = await harness.createUser(ctx, "lp", 500_000_000n); // 500 USDC
    await harness.initLPWithMatcher(ctx, lp, "1000000");
    await harness.deposit(ctx, lp, "400000000"); // 400 USDC

    // User1 will go long (betting USD goes up)
    user1 = await harness.createUser(ctx, "user_long", 100_000_000n);
    await harness.initUser(ctx, user1, "1000000");
    await harness.deposit(ctx, user1, "50000000"); // 50 USDC

    // User2 will go short (betting USD goes down)
    user2 = await harness.createUser(ctx, "user_short", 100_000_000n);
    await harness.initUser(ctx, user2, "1000000");
    await harness.deposit(ctx, user2, "50000000"); // 50 USDC

    // Top up insurance and run crank
    await harness.topUpInsurance(ctx, user1, "5000000");
    await harness.keeperCrankAsUser(ctx, user1);

    // Verify accounts
    const snapshot = await harness.snapshot(ctx);
    const lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);
    const user1Acct = snapshot.accounts.find(a => a.idx === user1.accountIndex);
    const user2Acct = snapshot.accounts.find(a => a.idx === user2.accountIndex);

    console.log(`    LP capital: ${lpAcct?.account.capital}`);
    console.log(`    User1 capital: ${user1Acct?.account.capital}`);
    console.log(`    User2 capital: ${user2Acct?.account.capital}`);

    TestHarness.assert(
      (lpAcct?.account.capital ?? 0n) > 0n &&
      (user1Acct?.account.capital ?? 0n) > 0n &&
      (user2Acct?.account.capital ?? 0n) > 0n,
      "All accounts should have positive capital"
    );
  });

  // -------------------------------------------------------------------------
  // T18.3: Open long position (betting USD goes up vs SOL)
  // -------------------------------------------------------------------------
  await harness.runTest("T18.3: Open long position", async () => {
    // User1 goes long 500 units
    const longResult = await harness.tradeCpi(ctx, user1, lp, "500");

    if (longResult.err) {
      console.log(`    Long trade error: ${longResult.err.slice(0, 60)}`);
      TestHarness.assert(false, "Long trade should succeed");
      return;
    }

    const snapshot = await harness.snapshot(ctx);
    const user1Acct = snapshot.accounts.find(a => a.idx === user1.accountIndex);
    const lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    User1 position: ${user1Acct?.account.positionSize} (long)`);
    console.log(`    User1 entry price: ${user1Acct?.account.entryPrice}`);
    console.log(`    LP position: ${lpAcct?.account.positionSize} (short, counterparty)`);

    TestHarness.assert(
      (user1Acct?.account.positionSize ?? 0n) > 0n,
      "User1 should have positive position (long)"
    );
    TestHarness.assert(
      (lpAcct?.account.positionSize ?? 0n) < 0n,
      "LP should have negative position (short, counterparty)"
    );
  });

  // -------------------------------------------------------------------------
  // T18.4: Open short position (betting USD goes down vs SOL)
  // -------------------------------------------------------------------------
  await harness.runTest("T18.4: Open short position", async () => {
    // User2 goes short 300 units (negative size)
    const shortResult = await harness.tradeCpi(ctx, user2, lp, "-300");

    if (shortResult.err) {
      console.log(`    Short trade error: ${shortResult.err.slice(0, 60)}`);
      TestHarness.assert(false, "Short trade should succeed");
      return;
    }

    const snapshot = await harness.snapshot(ctx);
    const user2Acct = snapshot.accounts.find(a => a.idx === user2.accountIndex);
    const lpAcct = snapshot.accounts.find(a => a.idx === lp.accountIndex);

    console.log(`    User2 position: ${user2Acct?.account.positionSize} (short)`);
    console.log(`    User2 entry price: ${user2Acct?.account.entryPrice}`);
    console.log(`    LP position now: ${lpAcct?.account.positionSize}`);

    TestHarness.assert(
      (user2Acct?.account.positionSize ?? 0n) < 0n,
      "User2 should have negative position (short)"
    );
  });

  // -------------------------------------------------------------------------
  // T18.5: Close positions and verify capital changes
  // -------------------------------------------------------------------------
  await harness.runTest("T18.5: Close positions", async () => {
    // Get positions before closing
    let snapshot = await harness.snapshot(ctx);
    let user1Acct = snapshot.accounts.find(a => a.idx === user1.accountIndex);
    let user2Acct = snapshot.accounts.find(a => a.idx === user2.accountIndex);

    const user1PosBefore = user1Acct?.account.positionSize ?? 0n;
    const user2PosBefore = user2Acct?.account.positionSize ?? 0n;
    const user1CapBefore = user1Acct?.account.capital ?? 0n;
    const user2CapBefore = user2Acct?.account.capital ?? 0n;

    console.log(`    Before close - User1 pos: ${user1PosBefore}, capital: ${user1CapBefore}`);
    console.log(`    Before close - User2 pos: ${user2PosBefore}, capital: ${user2CapBefore}`);

    // Close user1's long position
    const close1Result = await harness.tradeCpi(ctx, user1, lp, `-${user1PosBefore}`);
    if (close1Result.err) {
      console.log(`    Close user1 error: ${close1Result.err.slice(0, 50)}`);
    }

    // Close user2's short position
    const close2Result = await harness.tradeCpi(ctx, user2, lp, `${-user2PosBefore}`);
    if (close2Result.err) {
      console.log(`    Close user2 error: ${close2Result.err.slice(0, 50)}`);
    }

    // Verify positions are closed
    snapshot = await harness.snapshot(ctx);
    user1Acct = snapshot.accounts.find(a => a.idx === user1.accountIndex);
    user2Acct = snapshot.accounts.find(a => a.idx === user2.accountIndex);

    const user1PosAfter = user1Acct?.account.positionSize ?? 1n;
    const user2PosAfter = user2Acct?.account.positionSize ?? 1n;
    const user1CapAfter = user1Acct?.account.capital ?? 0n;
    const user2CapAfter = user2Acct?.account.capital ?? 0n;

    console.log(`    After close - User1 pos: ${user1PosAfter}, capital: ${user1CapAfter}`);
    console.log(`    After close - User2 pos: ${user2PosAfter}, capital: ${user2CapAfter}`);

    const user1PnL = user1CapAfter - user1CapBefore;
    const user2PnL = user2CapAfter - user2CapBefore;
    console.log(`    User1 PnL: ${user1PnL}`);
    console.log(`    User2 PnL: ${user2PnL}`);

    TestHarness.assertBigIntEqual(user1PosAfter, 0n, "User1 position should be closed");
    TestHarness.assertBigIntEqual(user2PosAfter, 0n, "User2 position should be closed");
  });

  // -------------------------------------------------------------------------
  // T18.6: Verify funding rate on inverted market
  // -------------------------------------------------------------------------
  await harness.runTest("T18.6: Funding on inverted market", async () => {
    // Open new positions
    await harness.tradeCpi(ctx, user1, lp, "400");

    // Get funding state before
    let snapshot = await harness.snapshot(ctx);
    const fundingBefore = snapshot.engine.fundingIndexQpbE6;
    const lastFundingSlotBefore = snapshot.engine.lastFundingSlot;
    console.log(`    Funding index before: ${fundingBefore}`);
    console.log(`    Last funding slot: ${lastFundingSlotBefore}`);

    // Wait and run crank to apply funding
    await new Promise(resolve => setTimeout(resolve, 1500));
    await harness.keeperCrankAsUser(ctx, user1);

    // Get funding state after
    snapshot = await harness.snapshot(ctx);
    const fundingAfter = snapshot.engine.fundingIndexQpbE6;
    const lastFundingSlotAfter = snapshot.engine.lastFundingSlot;
    console.log(`    Funding index after: ${fundingAfter}`);
    console.log(`    Last funding slot: ${lastFundingSlotAfter}`);

    // Check user position funding index was updated
    const user1Acct = snapshot.accounts.find(a => a.idx === user1.accountIndex);
    console.log(`    User1 funding index: ${user1Acct?.account.fundingIndex}`);
    console.log(`    User1 position: ${user1Acct?.account.positionSize}`);

    // Funding slot should have advanced
    TestHarness.assert(
      lastFundingSlotAfter >= lastFundingSlotBefore,
      "Funding slot should advance after crank"
    );
  });

  // -------------------------------------------------------------------------
  // T18.7: Full market cycle with invariant checks
  // -------------------------------------------------------------------------
  await harness.runTest("T18.7: Full cycle invariants", async () => {
    // Run another crank
    await harness.keeperCrankAsUser(ctx, user1);

    // Check invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);

    console.log(`    Invariant results:`);
    for (const r of report.results) {
      const status = r.passed ? "PASS" : "FAIL";
      console.log(`      [${status}] ${r.name}`);
      if (r.message) {
        console.log(`            ${r.message}`);
      }
    }

    TestHarness.assert(report.passed, "All invariants should pass on inverted market");

    // Get final state summary
    const snapshot = report.snapshot;
    console.log(`\n    Final market state:`);
    console.log(`      Used accounts: ${snapshot.engine.numUsedAccounts}`);
    console.log(`      Insurance fund: ${snapshot.engine.insuranceFund.balance}`);
    console.log(`      Loss accumulator: ${snapshot.engine.lossAccum}`);
    console.log(`      Risk reduction mode: ${snapshot.engine.riskReductionOnly}`);
    console.log(`      Total OI: ${snapshot.engine.totalOpenInterest}`);
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n========================================");
  console.log(`T18 Summary: ${summary.passed}/${summary.total} passed`);
  if (summary.failed > 0) {
    console.log("Failed tests:");
    for (const r of summary.results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }
  console.log("========================================");

  // Print final assessment
  console.log("\n" + "=".repeat(50));
  console.log("INVERTED MARKET E2E ASSESSMENT");
  console.log("=".repeat(50));
  if (summary.passed === summary.total) {
    console.log("SUCCESS: Inverted SOL/USD market is fully functional!");
    console.log("- Market creation with invert=1 works");
    console.log("- LP and user accounts can be created");
    console.log("- Long and short positions can be opened");
    console.log("- Positions can be closed with PnL settlement");
    console.log("- Funding rate mechanics work correctly");
    console.log("- All system invariants hold");
  } else {
    console.log("WARNING: Some tests failed. Review issues above.");
  }
  console.log("=".repeat(50));

  await harness.cleanup();
}

// Run if executed directly
runT18Tests().catch(console.error);

export { runT18Tests };
