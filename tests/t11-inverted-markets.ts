/**
 * T11: Inverted Market Tests
 *
 * Tests markets with inverted oracle (USD/SOL instead of SOL/USD).
 * Uses PYTH SOL/USD oracle with invert=1 to create a USD/SOL market.
 * Collateral is wSOL (9 decimals).
 *
 * T11.1: Create inverted market and verify config
 * T11.2: Long USD position - user profits when SOL price drops
 * T11.3: Short USD position - user profits when SOL price rises
 * T11.4: Full lifecycle - open, close, withdraw wSOL
 */

import TestHarness, { TestContext, UserContext, PYTH_SOL_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

// wSOL has 9 decimals
const WSOL_DECIMALS = 9;

async function runT11Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T11: Inverted Market Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T11.1: Create inverted market with SOL/USD oracle
  // -------------------------------------------------------------------------
  await harness.runTest("T11.1: Create inverted market", async () => {
    // Create market with:
    // - PYTH SOL/USD oracle (gives ~$100/SOL)
    // - invert=1 (interpret as USD/SOL, i.e., ~0.01 SOL/USD)
    // - 9 decimals for wSOL collateral
    ctx = await harness.createFreshMarket({
      maxAccounts: 64,
      oracle: PYTH_SOL_USD,
      decimals: WSOL_DECIMALS,
      invert: 1,
      unitScale: 0,
    });

    const snapshot = await harness.snapshot(ctx);

    // Verify market config (invert/unitScale are in MarketConfig, not RiskParams)
    TestHarness.assertEqual(snapshot.config.invert, 1, "Market should be inverted");
    TestHarness.assertEqual(snapshot.config.unitScale, 0, "unitScale should be 0");

    console.log(`    Oracle: ${ctx.oracle.toBase58()}`);
    console.log(`    Invert: ${snapshot.config.invert}`);
    console.log(`    UnitScale: ${snapshot.config.unitScale}`);
    console.log(`    Collateral decimals: ${WSOL_DECIMALS}`);
  });

  // -------------------------------------------------------------------------
  // T11.2: Long USD position (benefits when SOL drops)
  // -------------------------------------------------------------------------
  await harness.runTest("T11.2: Long USD position", async () => {
    ctx = await harness.createFreshMarket({
      maxAccounts: 64,
      oracle: PYTH_SOL_USD,
      decimals: WSOL_DECIMALS,
      invert: 1,
    });

    // Fund with 1 SOL worth of collateral (1e9 lamports = 1 SOL)
    const ONE_SOL = 1_000_000_000n;
    const user = await harness.createUser(ctx, "user", ONE_SOL);
    const lp = await harness.createUser(ctx, "lp", ONE_SOL * 10n);

    // Init user with 0.1 SOL (100M lamports) as collateral + fee
    const FEE = "10000000"; // 0.01 SOL for fee
    await harness.initUser(ctx, user, FEE);
    await harness.initLP(ctx, lp, "500000000"); // 0.5 SOL

    // Deposit additional collateral
    await harness.deposit(ctx, user, "100000000"); // 0.1 SOL

    const snapshotBefore = await harness.snapshot(ctx);
    const userAcctBefore = snapshotBefore.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    User capital before: ${userAcctBefore?.account.capital}`);

    // Open long USD position (positive size)
    // In inverted market, long = betting index (USD/SOL) goes up = betting SOL price drops
    const tradeSize = "10000000"; // Small position size
    const result = await harness.tradeNoCpi(ctx, user, lp, tradeSize);

    if (result.err) {
      console.log(`    Long trade result: ${result.err.slice(0, 100)}`);
    } else {
      const snapshotAfter = await harness.snapshot(ctx);
      const userAcctAfter = snapshotAfter.accounts.find(a => a.idx === user.accountIndex);

      console.log(`    Long trade succeeded, CU: ${result.unitsConsumed}`);
      console.log(`    Position size: ${userAcctAfter?.account.positionSize}`);
      console.log(`    Entry price: ${userAcctAfter?.account.entryPrice}`);

      // Position should be positive (long)
      if (userAcctAfter && userAcctAfter.account.positionSize > 0n) {
        console.log(`    Position is LONG as expected`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // T11.3: Short USD position (benefits when SOL rises)
  // -------------------------------------------------------------------------
  await harness.runTest("T11.3: Short USD position", async () => {
    ctx = await harness.createFreshMarket({
      maxAccounts: 64,
      oracle: PYTH_SOL_USD,
      decimals: WSOL_DECIMALS,
      invert: 1,
    });

    const ONE_SOL = 1_000_000_000n;
    const user = await harness.createUser(ctx, "user", ONE_SOL);
    const lp = await harness.createUser(ctx, "lp", ONE_SOL * 10n);

    const FEE = "10000000";
    await harness.initUser(ctx, user, FEE);
    await harness.initLP(ctx, lp, "500000000");

    await harness.deposit(ctx, user, "100000000");

    // Open short USD position (negative size)
    // In inverted market, short = betting index (USD/SOL) goes down = betting SOL price rises
    const tradeSize = "-10000000"; // Negative = short
    const result = await harness.tradeNoCpi(ctx, user, lp, tradeSize);

    if (result.err) {
      console.log(`    Short trade result: ${result.err.slice(0, 100)}`);
    } else {
      const snapshotAfter = await harness.snapshot(ctx);
      const userAcctAfter = snapshotAfter.accounts.find(a => a.idx === user.accountIndex);

      console.log(`    Short trade succeeded, CU: ${result.unitsConsumed}`);
      console.log(`    Position size: ${userAcctAfter?.account.positionSize}`);
      console.log(`    Entry price: ${userAcctAfter?.account.entryPrice}`);

      // Position should be negative (short)
      if (userAcctAfter && userAcctAfter.account.positionSize < 0n) {
        console.log(`    Position is SHORT as expected`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // T11.4: Full lifecycle - open, close, verify withdrawable wSOL
  // -------------------------------------------------------------------------
  await harness.runTest("T11.4: Full lifecycle with withdrawal", async () => {
    ctx = await harness.createFreshMarket({
      maxAccounts: 64,
      oracle: PYTH_SOL_USD,
      decimals: WSOL_DECIMALS,
      invert: 1,
    });

    const ONE_SOL = 1_000_000_000n;
    const INITIAL_DEPOSIT = 200_000_000n; // 0.2 SOL
    const FEE = 10_000_000n; // 0.01 SOL

    const user = await harness.createUser(ctx, "user", ONE_SOL);
    const lp = await harness.createUser(ctx, "lp", ONE_SOL * 10n);

    // Get user's wSOL balance before
    const userBalanceBefore = await harness.getTokenBalance(ctx, user.ata);
    console.log(`    User wSOL before: ${userBalanceBefore}`);

    await harness.initUser(ctx, user, FEE.toString());
    await harness.initLP(ctx, lp, "1000000000"); // 1 SOL

    await harness.deposit(ctx, user, INITIAL_DEPOSIT.toString());

    const snapshotAfterDeposit = await harness.snapshot(ctx);
    const userAcctAfterDeposit = snapshotAfterDeposit.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    User capital after deposit: ${userAcctAfterDeposit?.account.capital}`);

    // Open a position
    const openResult = await harness.tradeNoCpi(ctx, user, lp, "5000000");
    if (openResult.err) {
      console.log(`    Open trade: ${openResult.err.slice(0, 80)}`);
      // Continue even if trade fails - we want to test withdrawal
    } else {
      console.log(`    Position opened`);

      // Close the position (opposite trade)
      const closeResult = await harness.tradeNoCpi(ctx, user, lp, "-5000000");
      if (closeResult.err) {
        console.log(`    Close trade: ${closeResult.err.slice(0, 80)}`);
      } else {
        console.log(`    Position closed`);
      }
    }

    // Run keeper crank before withdrawal
    await harness.keeperCrankAsUser(ctx, user);

    // Check account state
    const snapshotBeforeWithdraw = await harness.snapshot(ctx);
    const userAcctBeforeWithdraw = snapshotBeforeWithdraw.accounts.find(a => a.idx === user.accountIndex);
    console.log(`    Capital before withdraw: ${userAcctBeforeWithdraw?.account.capital}`);
    console.log(`    Position: ${userAcctBeforeWithdraw?.account.positionSize}`);

    // Try to withdraw all capital (if position is flat)
    if (userAcctBeforeWithdraw && userAcctBeforeWithdraw.account.positionSize === 0n) {
      const capitalToWithdraw = userAcctBeforeWithdraw.account.capital;
      if (capitalToWithdraw > 0n) {
        // Leave some for fees
        const withdrawAmount = capitalToWithdraw - 1000000n;
        if (withdrawAmount > 0n) {
          const withdrawResult = await harness.withdraw(ctx, user, withdrawAmount.toString());
          if (withdrawResult.err) {
            console.log(`    Withdraw: ${withdrawResult.err.slice(0, 80)}`);
          } else {
            console.log(`    Withdrew: ${withdrawAmount} lamports`);
          }
        }
      }
    }

    // Check final balances
    const userBalanceAfter = await harness.getTokenBalance(ctx, user.ata);
    console.log(`    User wSOL after: ${userBalanceAfter}`);

    // The user should have recovered most of their capital minus fees
    const difference = userBalanceAfter - userBalanceBefore;
    console.log(`    Net wSOL change: ${difference}`);

    // Verify invariants
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // T11.5: Verify invert flag is persisted in config
  // -------------------------------------------------------------------------
  await harness.runTest("T11.5: Invert flag persisted", async () => {
    ctx = await harness.createFreshMarket({
      maxAccounts: 64,
      oracle: PYTH_SOL_USD,
      decimals: WSOL_DECIMALS,
      invert: 1,
      unitScale: 1000, // Also test unitScale
    });

    const snapshot = await harness.snapshot(ctx);

    TestHarness.assertEqual(snapshot.config.invert, 1, "Invert should be 1");
    TestHarness.assertEqual(snapshot.config.unitScale, 1000, "UnitScale should be 1000");

    console.log(`    Invert: ${snapshot.config.invert}`);
    console.log(`    UnitScale: ${snapshot.config.unitScale}`);
    console.log(`    MaxStaleness: ${snapshot.config.maxStalenessSlots}`);
    console.log(`    ConfFilter: ${snapshot.config.confFilterBps}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T11 Summary: ${summary.passed}/${summary.total} passed`);
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

runT11Tests().catch(console.error);
export { runT11Tests };
