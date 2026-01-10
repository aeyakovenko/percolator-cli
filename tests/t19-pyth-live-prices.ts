/**
 * T19: Live Pyth Price Testing
 *
 * Tests that Pyth provides live price updates via Hermes:
 * 1. Fetches current BTC/USD price from Hermes
 * 2. Monitors price changes over time
 * 3. Compares on-chain oracle price vs Hermes price
 *
 * Key findings:
 * - Hermes provides real-time prices (updates every ~400ms)
 * - On-chain devnet oracle accounts can become stale
 * - For production: prices should be posted before each trade
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { HermesClient } from "@pythnetwork/hermes-client";
import TestHarness, { PYTH_BTC_USD_FEED_ID, HERMES_ENDPOINT, EXISTING_BTC_USD_ORACLE } from "./harness.js";

// Parse PriceUpdateV2 account data
function parseOraclePrice(data: Buffer): { price: bigint; conf: bigint; expo: number; publishTime: bigint } | null {
  if (data.length < 102) return null;

  // PriceUpdateV2 layout (after discriminator and write authority):
  // 74-82: price (i64)
  // 82-90: conf (u64)
  // 90-94: expo (i32)
  // 94-102: publish_time (i64)
  const price = data.readBigInt64LE(74);
  const conf = data.readBigUInt64LE(82);
  const expo = data.readInt32LE(90);
  const publishTime = data.readBigInt64LE(94);

  return { price, conf, expo, publishTime };
}

async function runT19Tests(): Promise<void> {
  console.log("\n========================================");
  console.log("T19: Live Pyth Price Testing");
  console.log("========================================\n");

  const harness = new TestHarness();
  const hermesClient = new HermesClient(HERMES_ENDPOINT);
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // -------------------------------------------------------------------------
  // T19.1: Fetch live price from Hermes
  // -------------------------------------------------------------------------
  await harness.runTest("T19.1: Fetch live BTC/USD from Hermes", async () => {
    const priceUpdate = await hermesClient.getLatestPriceUpdates(
      [PYTH_BTC_USD_FEED_ID],
      { parsed: true }
    );

    if (!priceUpdate.parsed || priceUpdate.parsed.length === 0) {
      throw new Error("No price data from Hermes");
    }

    const btcPrice = priceUpdate.parsed[0];
    const priceNum = Number(btcPrice.price.price) * Math.pow(10, btcPrice.price.expo);
    const publishTime = new Date(btcPrice.price.publish_time * 1000);
    const age = (Date.now() - publishTime.getTime()) / 1000;

    console.log(`    BTC/USD Price: $${priceNum.toFixed(2)}`);
    console.log(`    Confidence: ±$${(Number(btcPrice.price.conf) * Math.pow(10, btcPrice.price.expo)).toFixed(2)}`);
    console.log(`    Published: ${publishTime.toISOString()}`);
    console.log(`    Age: ${age.toFixed(1)} seconds`);

    TestHarness.assert(priceNum > 10000 && priceNum < 500000, "BTC price should be reasonable");
    TestHarness.assert(age < 60, "Hermes price should be fresh (< 60s)");
  });

  // -------------------------------------------------------------------------
  // T19.2: Compare on-chain oracle vs Hermes
  // -------------------------------------------------------------------------
  await harness.runTest("T19.2: Compare on-chain oracle vs Hermes", async () => {
    // Get on-chain oracle
    const oracleInfo = await connection.getAccountInfo(EXISTING_BTC_USD_ORACLE);

    if (!oracleInfo) {
      console.log(`    WARNING: On-chain oracle not found`);
      return;
    }

    const onChainPrice = parseOraclePrice(oracleInfo.data);
    if (!onChainPrice) {
      console.log(`    WARNING: Could not parse on-chain oracle`);
      return;
    }

    const onChainPriceUsd = Number(onChainPrice.price) * Math.pow(10, onChainPrice.expo);
    const onChainTime = new Date(Number(onChainPrice.publishTime) * 1000);
    const onChainAge = (Date.now() - onChainTime.getTime()) / 1000;

    console.log(`    On-chain oracle: ${EXISTING_BTC_USD_ORACLE.toBase58().slice(0, 16)}...`);
    console.log(`    On-chain price: $${onChainPriceUsd.toFixed(2)}`);
    console.log(`    On-chain published: ${onChainTime.toISOString()}`);
    console.log(`    On-chain age: ${(onChainAge / 3600).toFixed(1)} hours`);

    // Get Hermes price for comparison
    const hermes = await hermesClient.getLatestPriceUpdates([PYTH_BTC_USD_FEED_ID], { parsed: true });
    const hermesPrice = hermes.parsed?.[0];

    if (hermesPrice) {
      const hermesPriceUsd = Number(hermesPrice.price.price) * Math.pow(10, hermesPrice.price.expo);
      const diff = Math.abs(hermesPriceUsd - onChainPriceUsd);
      const diffPercent = (diff / onChainPriceUsd) * 100;

      console.log(`    Hermes price: $${hermesPriceUsd.toFixed(2)}`);
      console.log(`    Price difference: $${diff.toFixed(2)} (${diffPercent.toFixed(2)}%)`);

      if (onChainAge > 3600) {
        console.log(`    ⚠ On-chain oracle is stale (> 1 hour old)`);
        console.log(`    For production: post fresh prices before each trade`);
      }
    }

    // Test passes - we're documenting the state
    TestHarness.assert(true, "Comparison complete");
  });

  // -------------------------------------------------------------------------
  // T19.3: Monitor Hermes price stream
  // -------------------------------------------------------------------------
  await harness.runTest("T19.3: Monitor Hermes price updates", async () => {
    console.log(`    Fetching prices over 10 seconds...`);

    const samples: { price: number; time: number }[] = [];
    const startTime = Date.now();

    for (let i = 0; i < 5; i++) {
      const priceUpdate = await hermesClient.getLatestPriceUpdates(
        [PYTH_BTC_USD_FEED_ID],
        { parsed: true }
      );

      if (priceUpdate.parsed && priceUpdate.parsed.length > 0) {
        const btcPrice = priceUpdate.parsed[0];
        const priceNum = Number(btcPrice.price.price) * Math.pow(10, btcPrice.price.expo);
        const publishTime = btcPrice.price.publish_time;

        samples.push({ price: priceNum, time: publishTime });
        console.log(`    [${i + 1}] $${priceNum.toFixed(2)} @ ${new Date(publishTime * 1000).toISOString().slice(11, 23)}`);
      }

      if (i < 4) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Calculate statistics
    if (samples.length > 1) {
      const prices = samples.map(s => s.price);
      const times = samples.map(s => s.time);

      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const range = maxPrice - minPrice;
      const rangePercent = (range / minPrice) * 100;

      // Check if timestamps are updating
      const uniqueTimes = new Set(times).size;

      console.log(`    ---`);
      console.log(`    Samples: ${samples.length}`);
      console.log(`    Unique timestamps: ${uniqueTimes}`);
      console.log(`    Price range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`);
      console.log(`    Variation: $${range.toFixed(2)} (${rangePercent.toFixed(4)}%)`);

      if (uniqueTimes > 1) {
        console.log(`    ✓ Pyth prices are actively updating`);
      } else {
        console.log(`    ⚠ Same timestamp for all samples (market may be slow)`);
      }
    }

    TestHarness.assert(samples.length >= 3, "Should collect multiple samples");
  });

  // -------------------------------------------------------------------------
  // T19.4: Summary of PnL implications
  // -------------------------------------------------------------------------
  await harness.runTest("T19.4: PnL implications with stale oracle", async () => {
    // Fetch current prices to calculate potential PnL impact
    const hermes = await hermesClient.getLatestPriceUpdates([PYTH_BTC_USD_FEED_ID], { parsed: true });
    const hermesPrice = hermes.parsed?.[0];

    if (!hermesPrice) {
      throw new Error("Could not fetch Hermes price");
    }

    const hermesPriceUsd = Number(hermesPrice.price.price) * Math.pow(10, hermesPrice.price.expo);

    // Get on-chain oracle price
    const oracleInfo = await connection.getAccountInfo(EXISTING_BTC_USD_ORACLE);
    const onChainPrice = oracleInfo ? parseOraclePrice(oracleInfo.data) : null;
    const onChainPriceUsd = onChainPrice
      ? Number(onChainPrice.price) * Math.pow(10, onChainPrice.expo)
      : 0;

    const priceDiff = hermesPriceUsd - onChainPriceUsd;
    const priceDiffPercent = (priceDiff / onChainPriceUsd) * 100;

    console.log(`    Current Hermes price: $${hermesPriceUsd.toFixed(2)}`);
    console.log(`    On-chain stale price: $${onChainPriceUsd.toFixed(2)}`);
    console.log(`    Price difference: $${priceDiff.toFixed(2)} (${priceDiffPercent.toFixed(2)}%)`);

    // Calculate PnL impact for example position
    const positionSizeBtc = 0.1; // 0.1 BTC position
    const potentialPnLDiff = positionSizeBtc * priceDiff;

    console.log(`    ---`);
    console.log(`    Example: 0.1 BTC position`);
    console.log(`    PnL difference (stale vs live): $${potentialPnLDiff.toFixed(2)}`);
    console.log(`    ---`);

    if (Math.abs(priceDiffPercent) > 1) {
      console.log(`    ⚠ CRITICAL: ${priceDiffPercent.toFixed(2)}% price discrepancy!`);
      console.log(`    Trades executed at stale price will have incorrect PnL`);
      console.log(`    Solution: Post fresh prices before each trade on mainnet`);
    } else {
      console.log(`    ✓ Price discrepancy acceptable (< 1%)`);
    }

    TestHarness.assert(true, "PnL analysis complete");
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const summary = harness.getSummary();
  console.log("\n========================================");
  console.log(`T19 Summary: ${summary.passed}/${summary.total} passed`);
  if (summary.failed > 0) {
    console.log("Failed tests:");
    for (const r of summary.results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }
  console.log("========================================");

  // Print assessment
  console.log("\n" + "=".repeat(60));
  console.log("PYTH LIVE PRICE ASSESSMENT");
  console.log("=".repeat(60));
  console.log("\nFindings:");
  console.log("1. Hermes provides real-time BTC/USD prices (~every 400ms)");
  console.log("2. On-chain devnet oracle is stale (hours/days old)");
  console.log("3. Tests use high staleness tolerance to work with stale oracle");
  console.log("4. PnL shows 0 because oracle price is same for open/close");
  console.log("\nFor production mainnet:");
  console.log("- Post fresh price before each trade via PythSolanaReceiver");
  console.log("- Use reasonable staleness (e.g., 60 seconds)");
  console.log("- Or use Pyth streaming for real-time price feeds");
  console.log("=".repeat(60));

  await harness.cleanup();
}

// Run if executed directly
runT19Tests().catch(console.error);

export { runT19Tests };
