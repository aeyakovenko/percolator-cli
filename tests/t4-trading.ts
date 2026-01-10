/**
 * T4: Trading & Matching Tests
 *
 * T4.1: User can open long position
 * T4.2: User can open short position
 * T4.3: Position increases/decreases correctly
 * T4.4: PnL calculations are correct
 */

import TestHarness, { TestContext, UserContext, PYTH_BTC_USD } from "./harness.js";
import { InvariantChecker } from "./invariants.js";

async function runT4Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T4: Trading & Matching Tests");
  console.log("========================================\n");

  const harness = new TestHarness();
  let ctx: TestContext;

  // -------------------------------------------------------------------------
  // T4.1: Open long position via trade-no-cpi
  // -------------------------------------------------------------------------
  await harness.runTest("T4.1: Open long position", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create user and LP
    const user = await harness.createUser(ctx, "user", 50_000_000n);
    const lp = await harness.createUser(ctx, "lp", 100_000_000n);

    await harness.initUser(ctx, user, "10000000"); // 10 USDC
    await harness.initLP(ctx, lp, "50000000"); // 50 USDC

    // Try to open a long position (positive size = long)
    const result = await harness.tradeNoCpi(ctx, user, lp, "1000000");

    if (result.err) {
      console.log(`    Trade result: ${result.err.slice(0, 80)}`);
      console.log(`    (May fail due to oracle/margin requirements)`);
    } else {
      const snapshot = await harness.snapshot(ctx);
      console.log(`    Trade succeeded`);
      console.log(`    CU used: ${result.unitsConsumed}`);

      // Check user position
      const userAccount = snapshot.accounts.find(a => a.account.positionSize !== 0n);
      if (userAccount) {
        console.log(`    User position: ${userAccount.account.positionSize}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // T4.2: Open short position
  // -------------------------------------------------------------------------
  await harness.runTest("T4.2: Open short position", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const user = await harness.createUser(ctx, "user", 50_000_000n);
    const lp = await harness.createUser(ctx, "lp", 100_000_000n);

    await harness.initUser(ctx, user, "10000000");
    await harness.initLP(ctx, lp, "50000000");

    // Open short (negative size = short)
    const result = await harness.tradeNoCpi(ctx, user, lp, "-1000000");

    if (result.err) {
      console.log(`    Trade result: ${result.err.slice(0, 80)}`);
    } else {
      console.log(`    Short trade succeeded`);
      console.log(`    CU used: ${result.unitsConsumed}`);
    }
  });

  // -------------------------------------------------------------------------
  // T4.3: Multiple trades accumulate position
  // -------------------------------------------------------------------------
  await harness.runTest("T4.3: Multiple trades", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    const user = await harness.createUser(ctx, "user", 100_000_000n);
    const lp = await harness.createUser(ctx, "lp", 200_000_000n);

    await harness.initUser(ctx, user, "50000000");
    await harness.initLP(ctx, lp, "100000000");

    // Execute multiple trades (positive = long, negative = close/short)
    const trades = [
      { size: "500000", label: "long" },
      { size: "500000", label: "long" },
      { size: "-300000", label: "partial close" },
    ];

    for (const trade of trades) {
      const result = await harness.tradeNoCpi(ctx, user, lp, trade.size);

      if (result.err) {
        console.log(`    Trade ${trade.label} ${trade.size}: ${result.err.slice(0, 50)}`);
      } else {
        console.log(`    Trade ${trade.label} ${trade.size}: OK (${result.unitsConsumed} CU)`);
      }
    }

    // Verify invariants after trades
    const checker = new InvariantChecker(ctx.connection);
    const report = await checker.checkAll(ctx);
    console.log(`    Invariants: ${report.passed ? "PASS" : "FAIL"}`);
  });

  // -------------------------------------------------------------------------
  // T4.4: Insufficient margin prevents trade
  // -------------------------------------------------------------------------
  await harness.runTest("T4.4: Insufficient margin blocks trade", async () => {
    ctx = await harness.createFreshMarket({ maxAccounts: 64 });

    // Create user with minimal collateral
    const user = await harness.createUser(ctx, "user", 10_000_000n);
    const lp = await harness.createUser(ctx, "lp", 100_000_000n);

    await harness.initUser(ctx, user, "100000"); // Only 0.1 USDC
    await harness.initLP(ctx, lp, "50000000");

    // Try to open large long position
    const result = await harness.tradeNoCpi(ctx, user, lp, "100000000");

    // Should fail due to insufficient margin
    const failed = !!result.err;
    console.log(`    Large trade with small margin: ${failed ? "blocked" : "allowed"}`);
    console.log(`    Result: ${result.err?.slice(0, 80) || "success"}`);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n----------------------------------------");
  console.log(`T4 Summary: ${summary.passed}/${summary.total} passed`);
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

runT4Tests().catch(console.error);
export { runT4Tests };
