/**
 * Dump full market state with liquidation analysis
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, parseConfig, AccountKind } from '../src/solana/slab.js';
import * as fs from 'fs';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Helper to convert BigInt to string for JSON
function toJSON(obj: any): any {
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(toJSON);
  }
  if (obj && typeof obj === 'object') {
    if (obj.toBase58) {
      return obj.toBase58();
    }
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = toJSON(value);
    }
    return result;
  }
  return obj;
}

async function getChainlinkPrice(oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return { price: answer, decimals };
}

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const config = parseConfig(data);
  const params = parseParams(data);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  // Get live oracle price from Chainlink
  const oracleData = await getChainlinkPrice(ORACLE);
  const rawOraclePrice = oracleData.price;  // e.g. 142470000 for $142.47 (8 decimals)
  // Convert to e6 format for calculations
  const rawOraclePriceE6 = rawOraclePrice * 1_000_000n / BigInt(10 ** oracleData.decimals);
  // On-chain uses inverted price: 1e12 / price (SOL/USD instead of USD/SOL)
  const oraclePrice = 1_000_000_000_000n / rawOraclePriceE6;

  // Build accounts with liquidation analysis
  const accounts: any[] = [];

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    const label = acc.kind === AccountKind.LP ? 'LP' : `Trader ${idx}`;

    // Calculate margin metrics
    const posAbs = acc.positionSize < 0n ? -acc.positionSize : acc.positionSize;
    const notionalLamports = posAbs * oraclePrice / 1_000_000n;
    const maintenanceReq = notionalLamports * params.maintenanceMarginBps / 10_000n;
    const initialReq = notionalLamports * params.initialMarginBps / 10_000n;

    // Calculate unrealized PnL: position * (currentPrice - entryPrice) / 1e6
    // For LONG: profit when price goes up
    // For SHORT: profit when price goes down
    const unrealizedPnl = acc.positionSize * (oraclePrice - acc.entryPrice) / 1_000_000n;

    // Effective capital = capital + realized PnL + unrealized PnL
    // CRITICAL: Must include acc.pnl (realized PnL) to match engine's equity calculation
    const effectiveCapital = acc.capital + acc.pnl + unrealizedPnl;

    // Margin ratio calculation (bps)
    const marginRatioBps = notionalLamports > 0n ?
      (effectiveCapital * 10000n / notionalLamports) : 99999n;

    // Buffer = effective capital - maintenance requirement
    const buffer = effectiveCapital - maintenanceReq;

    // Liquidation analysis
    const isLiquidatable = buffer < 0n;
    const isAtRisk = !isLiquidatable && marginRatioBps < params.maintenanceMarginBps * 2n;
    const status = isLiquidatable ? 'LIQUIDATABLE' : isAtRisk ? 'AT_RISK' : 'SAFE';

    // Why should this account be liquidated?
    let liquidationReason = null;
    if (isLiquidatable) {
      liquidationReason = {
        reason: `Margin ratio ${Number(marginRatioBps) / 100}% is below maintenance margin ${Number(params.maintenanceMarginBps) / 100}%`,
        effectiveCapitalLamports: effectiveCapital.toString(),
        maintenanceRequiredLamports: maintenanceReq.toString(),
        shortfallLamports: (-buffer).toString(),
        notionalLamports: notionalLamports.toString(),
      };
    }

    accounts.push({
      index: idx,
      label,
      kind: acc.kind === AccountKind.LP ? 'LP' : 'USER',
      owner: acc.owner.toBase58(),
      position: {
        sizeUnits: acc.positionSize.toString(),
        direction: acc.positionSize > 0n ? 'LONG' : acc.positionSize < 0n ? 'SHORT' : 'FLAT',
        entryPrice: acc.entryPrice.toString(),
        notionalSol: Number(notionalLamports) / 1e9,
      },
      capitalSol: Number(acc.capital) / 1e9,
      realizedPnlSol: Number(acc.pnl) / 1e9,  // Realized PnL (from funding, previous trades)
      unrealizedPnlSol: Number(unrealizedPnl) / 1e9,
      effectiveCapitalSol: Number(effectiveCapital) / 1e9,
      margin: {
        maintenanceRequiredSol: Number(maintenanceReq) / 1e9,
        bufferSol: Number(buffer) / 1e9,
        ratioPercent: Number(marginRatioBps) / 100,
      },
      status,
      liquidationReason,
    });
  }

  const state = {
    timestamp: new Date().toISOString(),
    slab: SLAB.toBase58(),
    oracle: ORACLE.toBase58(),

    marketConfig: {
      invert: config.invert,
      unitScale: config.unitScale,
      confFilterBps: config.confFilterBps,
      maxStalenessSlots: config.maxStalenessSlots.toString(),
      // Funding rate config
      fundingHorizonSlots: config.fundingHorizonSlots.toString(),
      fundingKBps: Number(config.fundingKBps),
      fundingInvScaleNotionalE6: config.fundingInvScaleNotionalE6.toString(),
      fundingMaxPremiumBps: Number(config.fundingMaxPremiumBps),
      fundingMaxBpsPerSlot: Number(config.fundingMaxBpsPerSlot),
    },

    oraclePrice: {
      rawUsd: Number(rawOraclePrice) / Math.pow(10, oracleData.decimals),
      rawE6: rawOraclePriceE6.toString(),
      inverted: true,
      effectiveE6: oraclePrice.toString(),
      note: "Inverted price for SOL/USD perp",
    },

    riskParameters: {
      warmupPeriodSlots: params.warmupPeriodSlots.toString(),
      maintenanceMarginBps: Number(params.maintenanceMarginBps),
      maintenanceMarginPercent: Number(params.maintenanceMarginBps) / 100,
      initialMarginBps: Number(params.initialMarginBps),
      initialMarginPercent: Number(params.initialMarginBps) / 100,
      tradingFeeBps: Number(params.tradingFeeBps),
      maxAccounts: params.maxAccounts.toString(),
      newAccountFee: params.newAccountFee.toString(),
      riskReductionThreshold: params.riskReductionThreshold.toString(),
      maintenanceFeePerSlot: params.maintenanceFeePerSlot.toString(),
      maxCrankStalenessSlots: params.maxCrankStalenessSlots.toString(),
      liquidationFeeBps: Number(params.liquidationFeeBps),
      liquidationFeePercent: Number(params.liquidationFeeBps) / 100,
      liquidationFeeCap: params.liquidationFeeCap.toString(),
      liquidationBufferBps: Number(params.liquidationBufferBps),
      minLiquidationAbs: params.minLiquidationAbs.toString(),
    },

    engine: {
      vault: engine.vault.toString(),
      vaultSol: Number(engine.vault) / 1e9,
      insuranceFund: {
        balance: engine.insuranceFund.balance.toString(),
        balanceSol: Number(engine.insuranceFund.balance) / 1e9,
        feeRevenue: engine.insuranceFund.feeRevenue.toString(),
      },
      currentSlot: engine.currentSlot.toString(),
      fundingIndexQpbE6: engine.fundingIndexQpbE6.toString(),
      lastFundingSlot: engine.lastFundingSlot.toString(),
      lastCrankSlot: engine.lastCrankSlot.toString(),
      maxCrankStalenessSlots: engine.maxCrankStalenessSlots.toString(),
      totalOpenInterestUnits: engine.totalOpenInterest.toString(),
      totalOpenInterestSol: Number(engine.totalOpenInterest * oraclePrice / 1_000_000n) / 1e9,
      lossAccum: engine.lossAccum.toString(),
      riskReductionOnly: engine.riskReductionOnly,
      crankStep: engine.crankStep,
      lastSweepStartSlot: engine.lastSweepStartSlot.toString(),
      lastSweepCompleteSlot: engine.lastSweepCompleteSlot.toString(),
      lifetimeLiquidations: Number(engine.lifetimeLiquidations),
      lifetimeForceCloses: Number(engine.lifetimeForceCloses),
      // LP Aggregates for funding
      netLpPos: engine.netLpPos.toString(),
      netLpPosNotionalSol: Number(engine.netLpPos * oraclePrice / 1_000_000n) / 1e9,
      lpSumAbs: engine.lpSumAbs.toString(),
      numUsedAccounts: engine.numUsedAccounts,
    },

    // Funding rate analysis
    funding: (() => {
      const netLpPos = engine.netLpPos;
      const horizonSlots = config.fundingHorizonSlots;
      const kBps = config.fundingKBps;
      const invScale = config.fundingInvScaleNotionalE6;
      const maxPremiumBps = config.fundingMaxPremiumBps;
      const maxBpsPerSlot = config.fundingMaxBpsPerSlot;

      // Calculate funding rate using same formula as contract
      if (netLpPos === 0n || oraclePrice === 0n || horizonSlots === 0n) {
        return {
          currentIndexQpbE6: engine.fundingIndexQpbE6.toString(),
          lastFundingSlot: engine.lastFundingSlot.toString(),
          netLpPos: netLpPos.toString(),
          calculatedRateBpsPerSlot: 0,
          calculatedRateBpsPerHour: 0,
          direction: 'NEUTRAL',
          note: 'No funding (netLpPos=0 or oracle=0)',
        };
      }

      const absPos = netLpPos < 0n ? -netLpPos : netLpPos;
      const notionalE6 = absPos * oraclePrice / 1_000_000n;

      // premium_bps = (notional / scale) * k_bps
      let premiumBps = Number(notionalE6 * kBps / (invScale > 0n ? invScale : 1n));
      if (premiumBps > Number(maxPremiumBps)) premiumBps = Number(maxPremiumBps);

      // Apply sign and convert to per-slot
      let perSlotBps = (netLpPos > 0n ? premiumBps : -premiumBps) / Number(horizonSlots);
      if (perSlotBps > Number(maxBpsPerSlot)) perSlotBps = Number(maxBpsPerSlot);
      if (perSlotBps < -Number(maxBpsPerSlot)) perSlotBps = -Number(maxBpsPerSlot);

      return {
        currentIndexQpbE6: engine.fundingIndexQpbE6.toString(),
        lastFundingSlot: engine.lastFundingSlot.toString(),
        netLpPos: netLpPos.toString(),
        netLpPosNotionalSol: Number(notionalE6) / 1e6,
        calculatedRateBpsPerSlot: perSlotBps,
        calculatedRateBpsPerHour: perSlotBps * 7200,
        direction: netLpPos > 0n ? 'LONGS_PAY' : 'SHORTS_PAY',
        note: netLpPos > 0n ? 'LP net long - longs pay shorts to rebalance' : 'LP net short - shorts pay longs to rebalance',
      };
    })(),

    accounts,

    summary: {
      totalAccounts: accounts.length,
      liquidatable: accounts.filter(a => a.status === 'LIQUIDATABLE').length,
      atRisk: accounts.filter(a => a.status === 'AT_RISK').length,
      safe: accounts.filter(a => a.status === 'SAFE').length,
      totalLongNotionalSol: accounts.reduce((sum, a) => {
        return a.position.direction === 'LONG' ? sum + a.position.notionalSol : sum;
      }, 0),
      totalShortNotionalSol: accounts.reduce((sum, a) => {
        return a.position.direction === 'SHORT' ? sum + a.position.notionalSol : sum;
      }, 0),
    },

    liquidationAnalysis: {
      description: "Accounts are liquidatable when effective capital falls below maintenance margin requirement.",
      formula: "margin_ratio = effective_capital / notional_value",
      threshold: `Liquidation at margin_ratio < ${Number(params.maintenanceMarginBps) / 100}%`,
      liquidatableAccounts: accounts
        .filter(a => a.status === 'LIQUIDATABLE')
        .map(a => ({
          index: a.index,
          label: a.label,
          marginPercent: a.margin.ratioPercent,
          shortfallSol: -a.margin.bufferSol,
          notionalSol: a.position.notionalSol,
          reason: a.liquidationReason?.reason,
        })),
    },
  };

  // Write to file
  fs.writeFileSync('state.json', JSON.stringify(toJSON(state), null, 2));
  console.log('State dumped to state.json');

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Maintenance Margin: ${state.riskParameters.maintenanceMarginPercent}%`);
  console.log(`Initial Margin: ${state.riskParameters.initialMarginPercent}%`);
  console.log(`\nAccounts: ${state.summary.totalAccounts}`);
  console.log(`  LIQUIDATABLE: ${state.summary.liquidatable}`);
  console.log(`  AT RISK: ${state.summary.atRisk}`);
  console.log(`  SAFE: ${state.summary.safe}`);

  if (state.liquidationAnalysis.liquidatableAccounts.length > 0) {
    console.log('\n=== LIQUIDATABLE ACCOUNTS ===');
    for (const acc of state.liquidationAnalysis.liquidatableAccounts) {
      console.log(`\n[${acc.index}] ${acc.label}:`);
      console.log(`  Margin Ratio: ${acc.marginPercent.toFixed(2)}% (threshold: ${state.riskParameters.maintenanceMarginPercent}%)`);
      console.log(`  Shortfall: ${acc.shortfallSol.toFixed(6)} SOL`);
      console.log(`  Notional: ${acc.notionalSol.toFixed(6)} SOL`);
      console.log(`  Reason: ${acc.reason}`);
    }
  }
}

main().catch(console.error);
