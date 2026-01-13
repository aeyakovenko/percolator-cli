/**
 * Dump full market state with liquidation analysis
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseParams, parseEngine, parseAccount, parseUsedIndices, parseConfig, AccountKind } from '../src/solana/slab.js';
import * as fs from 'fs';

const SLAB = new PublicKey('8CUcauuMqAiB2xnT5c8VNM4zDHfbsedz6eLTAhHjACTe');
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

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const config = parseConfig(data);
  const params = parseParams(data);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  // Get oracle price - the entry prices (~7200) prove inversion is being used
  const rawOraclePrice = 138_000_000n; // ~$138 per SOL in e6 format
  // On-chain uses inverted price: 1e12 / price (SOL/USD instead of USD/SOL)
  // This matches the entry prices stored as ~7200-7300
  const oraclePrice = 1_000_000_000_000n / rawOraclePrice;  // Inverted: ~7246

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

    // Effective capital = capital + unrealized PnL (not the stored pnl field which is realized)
    const effectiveCapital = acc.capital + unrealizedPnl;

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
        size: acc.positionSize.toString(),
        direction: acc.positionSize > 0n ? 'LONG' : acc.positionSize < 0n ? 'SHORT' : 'FLAT',
        entryPrice: acc.entryPrice.toString(),
      },
      capital: {
        raw: acc.capital.toString(),
        sol: Number(acc.capital) / 1e9,
      },
      unrealizedPnl: {
        raw: unrealizedPnl.toString(),
        sol: Number(unrealizedPnl) / 1e9,
      },
      realizedPnl: {
        raw: acc.pnl.toString(),
        sol: Number(acc.pnl) / 1e9,
      },
      reservedPnl: acc.reservedPnl.toString(),
      margin: {
        notionalLamports: notionalLamports.toString(),
        notionalSol: Number(notionalLamports) / 1e9,
        maintenanceRequiredLamports: maintenanceReq.toString(),
        maintenanceRequiredSol: Number(maintenanceReq) / 1e9,
        initialRequiredLamports: initialReq.toString(),
        initialRequiredSol: Number(initialReq) / 1e9,
        effectiveCapitalLamports: effectiveCapital.toString(),
        effectiveCapitalSol: Number(effectiveCapital) / 1e9,
        bufferLamports: buffer.toString(),
        bufferSol: Number(buffer) / 1e9,
        marginRatioBps: Number(marginRatioBps),
        marginRatioPercent: Number(marginRatioBps) / 100,
      },
      status,
      liquidationReason,
      warmupStartedAtSlot: acc.warmupStartedAtSlot.toString(),
      warmupSlopePerStep: acc.warmupSlopePerStep.toString(),
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
    },

    oraclePrice: {
      rawE6: rawOraclePrice.toString(),
      rawUSD: Number(rawOraclePrice) / 1e6,
      inverted: true,
      effectiveE6: oraclePrice.toString(),
      effectiveValue: Number(oraclePrice) / 1e6,
      note: "Using inverted price (SOL/USD) - entry prices stored as ~7246",
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
      totalOpenInterestUsd: Number(engine.totalOpenInterest * oraclePrice / 1_000_000n) / 1e9 * Number(rawOraclePrice) / 1e6,
      lossAccum: engine.lossAccum.toString(),
      riskReductionOnly: engine.riskReductionOnly,
      numUsedAccounts: engine.numUsedAccounts,
    },

    accounts,

    summary: {
      totalAccounts: accounts.length,
      liquidatable: accounts.filter(a => a.status === 'LIQUIDATABLE').length,
      atRisk: accounts.filter(a => a.status === 'AT_RISK').length,
      safe: accounts.filter(a => a.status === 'SAFE').length,
      totalLongPositionSize: accounts.reduce((sum, a) => {
        const size = BigInt(a.position.size);
        return size > 0n ? sum + size : sum;
      }, 0n).toString(),
      totalShortPositionSize: accounts.reduce((sum, a) => {
        const size = BigInt(a.position.size);
        return size < 0n ? sum - size : sum;
      }, 0n).toString(),
    },

    liquidationAnalysis: {
      description: "Accounts are liquidatable when their effective capital (capital + PnL) falls below the maintenance margin requirement.",
      formula: "margin_ratio = effective_capital / notional_value",
      threshold: `Liquidation triggers when margin_ratio < ${Number(params.maintenanceMarginBps) / 100}% (${params.maintenanceMarginBps} bps)`,
      liquidatableAccounts: accounts
        .filter(a => a.status === 'LIQUIDATABLE')
        .map(a => ({
          index: a.index,
          label: a.label,
          marginRatioPercent: a.margin.marginRatioPercent,
          shortfallSol: -a.margin.bufferSol,
          position: a.position.size,
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
      console.log(`  Margin Ratio: ${acc.marginRatioPercent.toFixed(2)}% (threshold: ${state.riskParameters.maintenanceMarginPercent}%)`);
      console.log(`  Shortfall: ${acc.shortfallSol.toFixed(6)} SOL`);
      console.log(`  Position: ${acc.position}`);
      console.log(`  Reason: ${acc.reason}`);
    }
  }
}

main().catch(console.error);
