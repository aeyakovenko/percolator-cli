/**
 * Oracle Stress Simulator
 *
 * Simulates price movements and calculates stress scenarios without
 * needing actual oracle changes. Models:
 * - PnL at various price levels
 * - Liquidation thresholds
 * - Insurance fund depletion
 * - Bank run scenarios
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseParams, parseAccount, parseUsedIndices, parseConfig, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

interface Position {
  idx: number;
  kind: "USER" | "LP";
  positionSize: bigint;
  entryPrice: bigint;
  capital: bigint;
  pnl: bigint;
  direction: "LONG" | "SHORT" | "FLAT";
}

interface SimulationResult {
  priceUsd: number;
  effectivePrice: bigint;
  positions: {
    idx: number;
    direction: string;
    unrealizedPnl: number;
    effectiveCapital: number;
    marginRatio: number;
    isLiquidatable: boolean;
  }[];
  totalLongPnl: number;
  totalShortPnl: number;
  lpPnl: number;
  insuranceAfterExits: number;
  wouldTriggerRiskReduction: boolean;
  liquidatableCount: number;
}

async function getChainlinkPrice(oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await conn.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return { price: answer, decimals };
}

function calculateEffectivePrice(oraclePriceUsd: number): bigint {
  // Convert USD price to inverted E6 format (as used on-chain)
  if (oraclePriceUsd <= 0) return 0n;
  const priceE6 = BigInt(Math.round(oraclePriceUsd * 1_000_000));
  if (priceE6 === 0n) return 0n;
  return 1_000_000_000_000n / priceE6;
}

function calculateUnrealizedPnl(position: Position, currentPrice: bigint): bigint {
  // PnL = position * (currentPrice - entryPrice) / 1e6
  return position.positionSize * (currentPrice - position.entryPrice) / 1_000_000n;
}

function simulateAtPrice(
  positions: Position[],
  params: { maintenanceMarginBps: bigint; initialMarginBps: bigint },
  insuranceFund: bigint,
  threshold: bigint,
  oraclePriceUsd: number
): SimulationResult {
  const effectivePrice = calculateEffectivePrice(oraclePriceUsd);

  const results: SimulationResult = {
    priceUsd: oraclePriceUsd,
    effectivePrice,
    positions: [],
    totalLongPnl: 0,
    totalShortPnl: 0,
    lpPnl: 0,
    insuranceAfterExits: Number(insuranceFund) / 1e9,
    wouldTriggerRiskReduction: false,
    liquidatableCount: 0,
  };

  for (const pos of positions) {
    if (pos.direction === "FLAT") continue;

    const unrealizedPnl = calculateUnrealizedPnl(pos, effectivePrice);
    const effectiveCapital = pos.capital + pos.pnl + unrealizedPnl;

    const posAbs = pos.positionSize < 0n ? -pos.positionSize : pos.positionSize;
    const notional = posAbs * effectivePrice / 1_000_000n;
    const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;

    const marginRatio = notional > 0n ? Number(effectiveCapital * 10000n / notional) / 100 : 999;
    const isLiquidatable = effectiveCapital < maintenanceReq;

    const unrealizedPnlSol = Number(unrealizedPnl) / 1e9;

    results.positions.push({
      idx: pos.idx,
      direction: pos.direction,
      unrealizedPnl: unrealizedPnlSol,
      effectiveCapital: Number(effectiveCapital) / 1e9,
      marginRatio,
      isLiquidatable,
    });

    if (pos.kind === "LP") {
      results.lpPnl = unrealizedPnlSol;
    } else if (pos.direction === "LONG") {
      results.totalLongPnl += unrealizedPnlSol;
    } else {
      results.totalShortPnl += unrealizedPnlSol;
    }

    if (isLiquidatable) {
      results.liquidatableCount++;
    }
  }

  // Simulate bank run: winners exit first
  // If total positive PnL > insurance surplus, we'd have a problem
  const totalPositivePnl = Math.max(0, results.totalLongPnl) + Math.max(0, results.totalShortPnl);
  const surplus = Number(insuranceFund - threshold) / 1e9;

  // When winners exit, they extract their PnL from the system
  // Losers' losses go to insurance, but if winners > losers, insurance pays difference
  const totalNegativePnl = Math.abs(Math.min(0, results.totalLongPnl)) + Math.abs(Math.min(0, results.totalShortPnl));
  const netExtraction = totalPositivePnl - totalNegativePnl;

  results.insuranceAfterExits = surplus - Math.max(0, netExtraction);
  results.wouldTriggerRiskReduction = results.insuranceAfterExits < 0;

  return results;
}

async function main() {
  console.log("=== ORACLE STRESS SIMULATOR ===\n");

  // Fetch current state
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const config = parseConfig(data);
  const indices = parseUsedIndices(data);

  const oracleData = await getChainlinkPrice(ORACLE);
  const currentPriceUsd = Number(oracleData.price) / Math.pow(10, oracleData.decimals);

  console.log(`Current oracle price: $${currentPriceUsd.toFixed(2)}`);
  console.log(`Insurance fund: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(4)} SOL`);
  console.log(`Threshold: ${(Number(params.riskReductionThreshold) / 1e9).toFixed(4)} SOL`);
  console.log(`Maintenance margin: ${Number(params.maintenanceMarginBps) / 100}%`);
  console.log(`Initial margin: ${Number(params.initialMarginBps) / 100}%`);
  console.log();

  // Load all positions
  const positions: Position[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    const direction = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";
    positions.push({
      idx,
      kind: acc.kind === AccountKind.LP ? "LP" : "USER",
      positionSize: acc.positionSize,
      entryPrice: acc.entryPrice,
      capital: acc.capital,
      pnl: acc.pnl,
      direction,
    });
  }

  console.log("=== CURRENT POSITIONS ===");
  for (const pos of positions) {
    if (pos.direction === "FLAT") continue;
    const sizeStr = pos.positionSize.toString();
    console.log(`  ${pos.kind} ${pos.idx}: ${pos.direction} ${sizeStr}, entry: ${pos.entryPrice}, capital: ${(Number(pos.capital) / 1e9).toFixed(4)} SOL`);
  }
  console.log();

  // Simulate price scenarios
  const scenarios = [
    { name: "Current", pctChange: 0 },
    { name: "+5%", pctChange: 5 },
    { name: "+10%", pctChange: 10 },
    { name: "+20%", pctChange: 20 },
    { name: "+50%", pctChange: 50 },
    { name: "-5%", pctChange: -5 },
    { name: "-10%", pctChange: -10 },
    { name: "-20%", pctChange: -20 },
    { name: "-50%", pctChange: -50 },
  ];

  console.log("=== PRICE SCENARIO ANALYSIS ===\n");
  console.log("| Scenario | Price USD | Long PnL | Short PnL | LP PnL | Liquidatable | Insurance After | Risk Mode |");
  console.log("|----------|-----------|----------|-----------|--------|--------------|-----------------|-----------|");

  for (const scenario of scenarios) {
    const simPrice = currentPriceUsd * (1 + scenario.pctChange / 100);
    const result = simulateAtPrice(
      positions,
      { maintenanceMarginBps: params.maintenanceMarginBps, initialMarginBps: params.initialMarginBps },
      engine.insuranceFund.balance,
      params.riskReductionThreshold,
      simPrice
    );

    const riskMode = result.wouldTriggerRiskReduction ? "YES ⚠️" : "NO";
    console.log(
      `| ${scenario.name.padEnd(8)} | $${simPrice.toFixed(2).padStart(7)} | ${result.totalLongPnl.toFixed(2).padStart(8)} | ${result.totalShortPnl.toFixed(2).padStart(9)} | ${result.lpPnl.toFixed(2).padStart(6)} | ${result.liquidatableCount.toString().padStart(12)} | ${result.insuranceAfterExits.toFixed(2).padStart(15)} | ${riskMode.padStart(9)} |`
    );
  }

  console.log("\n=== DETAILED LIQUIDATION ANALYSIS ===\n");

  // Find liquidation prices for each position
  console.log("Liquidation price thresholds (5% maintenance margin):\n");

  for (const pos of positions) {
    if (pos.direction === "FLAT") continue;

    // Binary search for liquidation price
    let lowPrice = currentPriceUsd * 0.1;
    let highPrice = currentPriceUsd * 3;
    let liqPrice: number | null = null;

    for (let i = 0; i < 50; i++) {
      const midPrice = (lowPrice + highPrice) / 2;
      const effectivePrice = calculateEffectivePrice(midPrice);
      const unrealizedPnl = calculateUnrealizedPnl(pos, effectivePrice);
      const effectiveCapital = pos.capital + pos.pnl + unrealizedPnl;

      const posAbs = pos.positionSize < 0n ? -pos.positionSize : pos.positionSize;
      const notional = posAbs * effectivePrice / 1_000_000n;
      const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;

      const isLiquidatable = effectiveCapital < maintenanceReq;

      if (pos.direction === "LONG") {
        // Longs liquidate when price drops
        if (isLiquidatable) {
          liqPrice = midPrice;
          lowPrice = midPrice;
        } else {
          highPrice = midPrice;
        }
      } else {
        // Shorts liquidate when price rises
        if (isLiquidatable) {
          liqPrice = midPrice;
          highPrice = midPrice;
        } else {
          lowPrice = midPrice;
        }
      }
    }

    if (liqPrice) {
      const pctFromCurrent = ((liqPrice - currentPriceUsd) / currentPriceUsd * 100).toFixed(1);
      const sign = liqPrice > currentPriceUsd ? "+" : "";
      console.log(`  ${pos.kind} ${pos.idx} (${pos.direction}): liquidates at $${liqPrice.toFixed(2)} (${sign}${pctFromCurrent}% from current)`);
    } else {
      console.log(`  ${pos.kind} ${pos.idx} (${pos.direction}): no liquidation in range`);
    }
  }

  console.log("\n=== BANK RUN STRESS TEST ===\n");

  // Find the price at which insurance fund would be depleted
  console.log("Finding insurance depletion threshold...\n");

  for (const direction of ["up", "down"] as const) {
    let testPct = 0;
    let step = direction === "up" ? 5 : -5;
    let depletionPct: number | null = null;
    const maxPct = direction === "up" ? 200 : -90; // Don't go below 10% of current price

    for (let i = 0; i < 40; i++) {
      testPct += step;
      if ((direction === "up" && testPct > maxPct) || (direction === "down" && testPct < maxPct)) break;

      const simPrice = currentPriceUsd * (1 + testPct / 100);
      if (simPrice <= 1) continue; // Skip very low prices

      const result = simulateAtPrice(
        positions,
        { maintenanceMarginBps: params.maintenanceMarginBps, initialMarginBps: params.initialMarginBps },
        engine.insuranceFund.balance,
        params.riskReductionThreshold,
        simPrice
      );

      if (result.wouldTriggerRiskReduction && depletionPct === null) {
        depletionPct = testPct;
        break;
      }
    }

    if (depletionPct !== null) {
      const depletionPrice = currentPriceUsd * (1 + depletionPct / 100);
      console.log(`  Price ${direction}: Risk reduction triggered at ${depletionPct > 0 ? "+" : ""}${depletionPct}% ($${depletionPrice.toFixed(2)})`);
    } else {
      console.log(`  Price ${direction}: No risk reduction in tested range (${direction === "up" ? "+200%" : "-90%"})`);
    }
  }

  console.log("\n=== EXTREME SCENARIO: 50% CRASH ===\n");

  const crashPrice = currentPriceUsd * 0.5;
  const crashResult = simulateAtPrice(
    positions,
    { maintenanceMarginBps: params.maintenanceMarginBps, initialMarginBps: params.initialMarginBps },
    engine.insuranceFund.balance,
    params.riskReductionThreshold,
    crashPrice
  );

  // Note: This is an INVERTED price system (USD/SOL perp)
  // "LONG" positions profit when inverted price rises (i.e., USD price FALLS)
  // So in a SOL CRASH, the on-chain "LONGs" actually PROFIT
  console.log(`If SOL crashed to $${crashPrice.toFixed(2)}:`);
  console.log(`  User positions (all LONG inverted): ${crashResult.totalLongPnl > 0 ? "PROFIT" : "LOSS"} ${Math.abs(crashResult.totalLongPnl).toFixed(4)} SOL`);
  console.log(`  LP position (SHORT inverted): ${crashResult.lpPnl > 0 ? "PROFIT" : "LOSS"} ${Math.abs(crashResult.lpPnl).toFixed(4)} SOL`);
  console.log(`  Liquidatable accounts: ${crashResult.liquidatableCount}`);
  console.log(`  Insurance after bank run: ${crashResult.insuranceAfterExits.toFixed(4)} SOL`);
  console.log(`  Risk reduction mode: ${crashResult.wouldTriggerRiskReduction ? "YES ⚠️" : "NO"}`);

  console.log("\n=== EXTREME SCENARIO: 2X PUMP ===\n");

  const pumpPrice = currentPriceUsd * 2;
  const pumpResult = simulateAtPrice(
    positions,
    { maintenanceMarginBps: params.maintenanceMarginBps, initialMarginBps: params.initialMarginBps },
    engine.insuranceFund.balance,
    params.riskReductionThreshold,
    pumpPrice
  );

  console.log(`If SOL pumped to $${pumpPrice.toFixed(2)}:`);
  console.log(`  User positions (all LONG inverted): ${pumpResult.totalLongPnl > 0 ? "PROFIT" : "LOSS"} ${Math.abs(pumpResult.totalLongPnl).toFixed(4)} SOL`);
  console.log(`  LP position (SHORT inverted): ${pumpResult.lpPnl > 0 ? "PROFIT" : "LOSS"} ${Math.abs(pumpResult.lpPnl).toFixed(4)} SOL`);
  console.log(`  Liquidatable accounts: ${pumpResult.liquidatableCount}`);
  console.log(`  Insurance after bank run: ${pumpResult.insuranceAfterExits.toFixed(4)} SOL`);
  console.log(`  Risk reduction mode: ${pumpResult.wouldTriggerRiskReduction ? "YES ⚠️" : "NO"}`);

  console.log("\n=== INVERTED PRICE EXPLANATION ===");
  console.log("This market uses INVERTED oracle (USD/SOL instead of SOL/USD).");
  console.log("On-chain 'LONG' positions profit when SOL price DROPS (inverted price rises).");
  console.log("On-chain 'SHORT' positions profit when SOL price RISES (inverted price falls).");
  console.log("LP is SHORT inverted = economically LONG SOL.");

  console.log("\n=== RECOMMENDATIONS ===\n");

  const hasPositions = positions.some(p => p.direction !== "FLAT");
  if (!hasPositions) {
    console.log("⚠️  No open positions - stress scenarios have no effect");
    console.log("   Run scripts to open positions first: npx tsx scripts/imbalanced-test.ts");
  } else {
    console.log("Current market state analysis:");
    const longCount = positions.filter(p => p.kind === "USER" && p.direction === "LONG").length;
    const shortCount = positions.filter(p => p.kind === "USER" && p.direction === "SHORT").length;
    console.log(`  - ${longCount} LONGs, ${shortCount} SHORTs`);

    if (longCount > shortCount * 2 || shortCount > longCount * 2) {
      console.log("  - Market is imbalanced - good for funding rate stress");
    } else {
      console.log("  - Market is balanced - limited funding rate impact");
    }
  }
}

main().catch(console.error);
