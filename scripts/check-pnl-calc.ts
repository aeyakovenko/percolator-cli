/**
 * Investigate why PnL shows 0 despite position and price changes
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseAccount, parseConfig, parseParams, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  console.log("=== PNL CALCULATION INVESTIGATION ===\n");

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const params = parseParams(data);

  console.log("Market Config:");
  console.log("  Inverted:", config.invert === 1);
  console.log("  Unit Scale:", config.unitScale);
  console.log("  Authority Price:", (Number(config.authorityPriceE6) / 1e6).toFixed(6), "USD");

  console.log("\nEngine State:");
  console.log("  Current Slot:", engine.currentSlot.toString());
  console.log("  Funding Index (QpbE6):", engine.fundingIndexQpbE6.toString());
  console.log("  Last Funding Slot:", engine.lastFundingSlot.toString());
  console.log("  Total Open Interest:", engine.totalOpenInterest.toString());

  console.log("\nAccount 2 Details:");
  const acc = parseAccount(data, 2);
  console.log("  Account ID:", acc.accountId.toString());
  console.log("  Capital:", Number(acc.capital).toString(), `(${(Number(acc.capital) / 1e9).toFixed(9)} SOL)`);
  console.log("  Kind:", acc.kind === AccountKind.LP ? "LP" : "USER");

  // PnL parsing
  console.log("\n  Raw PnL (BigInt):", acc.pnl.toString());
  let pnl = acc.pnl;
  if (pnl > 9_000_000_000_000_000_000n) {
    pnl = pnl - 18446744073709551616n;
    console.log("  Adjusted PnL (signed):", pnl.toString());
  }
  console.log("  PnL in SOL:", (Number(pnl) / 1e9).toFixed(9));

  console.log("\n  Position Size:", acc.positionSize.toString());
  console.log("  Entry Price:", Number(acc.entryPrice).toString(), `($${(Number(acc.entryPrice) / 1e6).toFixed(2)})`);
  console.log("  Funding Index:", acc.fundingIndex.toString());

  // Manual PnL calculation
  console.log("\n=== MANUAL PNL CALCULATION ===");
  const currentPrice = config.authorityPriceE6;
  const entryPrice = acc.entryPrice;
  const positionSize = acc.positionSize;

  console.log("Current Price (E6):", currentPrice.toString());
  console.log("Entry Price (E6):", entryPrice.toString());
  console.log("Position Size:", positionSize.toString());

  // For a standard perp:
  // PnL = position_size * (exit_price - entry_price) / price_scale
  // For inverted perp (SOL/USD where SOL is collateral):
  // PnL = position_size * (1/entry_price - 1/exit_price) * some_scale

  // Standard calculation
  const priceDiff = Number(currentPrice) - Number(entryPrice);
  const posSize = Number(positionSize);
  const standardPnl = posSize * priceDiff / 1e6;
  console.log("\nStandard PnL calc:");
  console.log("  Price diff:", priceDiff / 1e6, "USD");
  console.log("  Standard PnL:", standardPnl.toFixed(6), "(units?)");

  // For inverted market
  // If collateral is SOL, and index is SOL/USD (inverted from USD/SOL)
  // PnL might be: position * (1/entry - 1/current) in SOL terms
  if (Number(currentPrice) > 0 && Number(entryPrice) > 0) {
    const invertedPnl = posSize * (1e6 / Number(entryPrice) - 1e6 / Number(currentPrice));
    console.log("\nInverted PnL calc:");
    console.log("  1/entry:", (1e6 / Number(entryPrice)).toFixed(6));
    console.log("  1/current:", (1e6 / Number(currentPrice)).toFixed(6));
    console.log("  Inverted PnL:", invertedPnl.toFixed(6), "(units?)");
  }

  // Funding-adjusted PnL
  console.log("\nFunding-related values:");
  console.log("  Engine Funding Index:", engine.fundingIndexQpbE6.toString());
  console.log("  Account Funding Index:", acc.fundingIndex.toString());
  const fundingDiff = engine.fundingIndexQpbE6 - acc.fundingIndex;
  console.log("  Funding Difference:", fundingDiff.toString());

  // Check if position is warmed up
  console.log("\nWarmup State:");
  console.log("  Warmup Started:", acc.warmupStarted.toString());
  console.log("  Warmup Slope:", acc.warmupSlope.toString());
  console.log("  Warmup Period (slots):", params.warmupPeriodSlots.toString());

  // Why might PnL be 0?
  console.log("\n=== HYPOTHESES ===");
  console.log("1. Position not yet warmed up (PnL not yet realized)");
  console.log("2. Inverted market calculation differs from standard");
  console.log("3. PnL only updates on crank/trade");
  console.log("4. Funding index changes offset price PnL");
  console.log("5. Reserved PnL mechanism holds back profit");

  console.log("\nReserved PnL:", acc.reservedPnl.toString());
}

main().catch(console.error);
