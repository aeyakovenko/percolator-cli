/**
 * Comprehensive market dump — ALL on-chain data structures to market.json
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchSlab, parseHeader, parseConfig, parseParams, parseEngine,
  parseAccount, parseUsedIndices, AccountKind,
} from "../src/solana/slab.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

function toJSON(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(toJSON);
  if (obj && typeof obj === "object") {
    if (obj.toBase58) return obj.toBase58();
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = toJSON(value);
    }
    return result;
  }
  return obj;
}

const sol = (n: bigint) => Number(n) / 1e9;
const pct = (bps: bigint) => Number(bps) / 100;

async function getChainlinkPrice(oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  return { price: info.data.readBigInt64LE(216), decimals: info.data.readUInt8(138) };
}

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const header = parseHeader(data);
  const config = parseConfig(data);
  const params = parseParams(data);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  // Oracle
  const oracleData = await getChainlinkPrice(ORACLE);
  const rawOraclePriceE6 = oracleData.price * 1_000_000n / BigInt(10 ** oracleData.decimals);
  const oraclePrice = rawOraclePriceE6 > 0n ? 1_000_000_000_000n / rawOraclePriceE6 : 0n;

  // Derived engine values
  const insurance = engine.insuranceFund.balance;
  const threshold = params.riskReductionThreshold;
  const surplus = insurance > threshold ? insurance - threshold : 0n;

  // Build accounts
  const accounts = indices.map(idx => {
    const acc = parseAccount(data, idx);
    if (!acc) return null;

    const posAbs = acc.positionSize < 0n ? -acc.positionSize : acc.positionSize;
    const notional = posAbs * oraclePrice / 1_000_000n;
    const unrealizedPnl = acc.positionSize * (oraclePrice - acc.entryPrice) / 1_000_000n;
    const effectiveCapital = acc.capital + acc.pnl + unrealizedPnl;
    const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;
    const marginRatioBps = notional > 0n ? effectiveCapital * 10_000n / notional : 99999n;

    return {
      index: idx,
      kind: acc.kind === AccountKind.LP ? "LP" : "USER",
      accountId: acc.accountId.toString(),
      owner: acc.owner.toBase58(),

      capital: {
        raw: acc.capital.toString(),
        sol: sol(acc.capital),
      },
      pnl: {
        realized: { raw: acc.pnl.toString(), sol: sol(acc.pnl) },
        unrealized: { raw: unrealizedPnl.toString(), sol: sol(unrealizedPnl) },
      },
      effectiveCapital: {
        raw: (effectiveCapital).toString(),
        sol: sol(effectiveCapital),
      },

      warmup: {
        reservedPnl: acc.reservedPnl.toString(),
        reservedPnlSol: sol(acc.reservedPnl),
        warmupStartedAtSlot: acc.warmupStartedAtSlot.toString(),
        warmupSlopePerStep: acc.warmupSlopePerStep.toString(),
        warmupSlopePerStepSol: sol(acc.warmupSlopePerStep),
      },

      position: {
        sizeUnits: acc.positionSize.toString(),
        direction: acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT",
        entryPriceE6: acc.entryPrice.toString(),
        notional: { raw: notional.toString(), sol: sol(notional) },
      },

      margin: {
        maintenanceRequired: { raw: maintenanceReq.toString(), sol: sol(maintenanceReq) },
        ratioPercent: Number(marginRatioBps) / 100,
        buffer: { raw: (effectiveCapital - maintenanceReq).toString(), sol: sol(effectiveCapital - maintenanceReq) },
        status: effectiveCapital < maintenanceReq ? "LIQUIDATABLE"
          : marginRatioBps < params.maintenanceMarginBps * 2n ? "AT_RISK" : "SAFE",
      },

      funding: {
        fundingIndex: acc.fundingIndex.toString(),
      },

      matcher: {
        program: acc.matcherProgram.toBase58(),
        context: acc.matcherContext.toBase58(),
      },

      fees: {
        feeCredits: acc.feeCredits.toString(),
        lastFeeSlot: acc.lastFeeSlot.toString(),
      },
    };
  }).filter(Boolean);

  // Total capital across all accounts
  let totalCapital = 0n;
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc) totalCapital += acc.capital;
  }

  const market = {
    _meta: {
      timestamp: new Date().toISOString(),
      slabAddress: SLAB.toBase58(),
      oracleAddress: ORACLE.toBase58(),
      slabDataBytes: data.length,
    },

    header: {
      magic: header.magic.toString(16),
      version: header.version,
      bump: header.bump,
      admin: header.admin.toBase58(),
      nonce: header.nonce.toString(),
      lastThresholdUpdateSlot: header.lastThrUpdateSlot.toString(),
    },

    config: {
      collateralMint: config.collateralMint.toBase58(),
      vault: config.vaultPubkey.toBase58(),
      indexFeedId: config.indexFeedId.toBase58(),
      maxStalenessSlots: config.maxStalenessSlots.toString(),
      confFilterBps: config.confFilterBps,
      vaultAuthorityBump: config.vaultAuthorityBump,
      invert: config.invert,
      unitScale: config.unitScale,

      funding: {
        horizonSlots: config.fundingHorizonSlots.toString(),
        kBps: Number(config.fundingKBps),
        invScaleNotionalE6: config.fundingInvScaleNotionalE6.toString(),
        maxPremiumBps: Number(config.fundingMaxPremiumBps),
        maxBpsPerSlot: Number(config.fundingMaxBpsPerSlot),
      },

      threshold: {
        floor: { raw: config.threshFloor.toString(), sol: sol(config.threshFloor) },
        riskBps: Number(config.threshRiskBps),
        updateIntervalSlots: config.threshUpdateIntervalSlots.toString(),
        stepBps: Number(config.threshStepBps),
        alphaBps: Number(config.threshAlphaBps),
        min: { raw: config.threshMin.toString(), sol: sol(config.threshMin) },
        max: { raw: config.threshMax.toString(), sol: sol(config.threshMax) },
        minStep: { raw: config.threshMinStep.toString(), sol: sol(config.threshMinStep) },
      },

      oracleAuthority: {
        authority: config.oracleAuthority.toBase58(),
        authorityPriceE6: config.authorityPriceE6.toString(),
        authorityTimestamp: config.authorityTimestamp.toString(),
      },
    },

    riskParams: {
      warmupPeriodSlots: params.warmupPeriodSlots.toString(),
      maintenanceMarginBps: Number(params.maintenanceMarginBps),
      maintenanceMarginPercent: pct(params.maintenanceMarginBps),
      initialMarginBps: Number(params.initialMarginBps),
      initialMarginPercent: pct(params.initialMarginBps),
      tradingFeeBps: Number(params.tradingFeeBps),
      maxAccounts: params.maxAccounts.toString(),
      newAccountFee: { raw: params.newAccountFee.toString(), sol: sol(params.newAccountFee) },
      riskReductionThreshold: { raw: params.riskReductionThreshold.toString(), sol: sol(params.riskReductionThreshold) },
      maintenanceFeePerSlot: { raw: params.maintenanceFeePerSlot.toString(), sol: sol(params.maintenanceFeePerSlot) },
      maxCrankStalenessSlots: params.maxCrankStalenessSlots.toString(),
      liquidationFeeBps: Number(params.liquidationFeeBps),
      liquidationFeePercent: pct(params.liquidationFeeBps),
      liquidationFeeCap: { raw: params.liquidationFeeCap.toString(), sol: sol(params.liquidationFeeCap) },
      liquidationBufferBps: Number(params.liquidationBufferBps),
      minLiquidationAbs: { raw: params.minLiquidationAbs.toString(), sol: sol(params.minLiquidationAbs) },
    },

    engine: {
      vault: { raw: engine.vault.toString(), sol: sol(engine.vault) },
      insuranceFund: {
        balance: { raw: insurance.toString(), sol: sol(insurance) },
        feeRevenue: { raw: engine.insuranceFund.feeRevenue.toString(), sol: sol(engine.insuranceFund.feeRevenue) },
        threshold: { raw: threshold.toString(), sol: sol(threshold) },
        surplus: { raw: surplus.toString(), sol: sol(surplus) },
      },
      lossAccum: { raw: engine.lossAccum.toString(), sol: sol(engine.lossAccum) },
      riskReductionOnly: engine.riskReductionOnly,
      riskReductionModeWithdrawn: { raw: engine.riskReductionModeWithdrawn.toString(), sol: sol(engine.riskReductionModeWithdrawn) },

      warmup: {
        paused: engine.warmupPaused,
        pauseSlot: engine.warmupPauseSlot.toString(),
        warmedPosTotal: { raw: engine.warmedPosTotal.toString(), sol: sol(engine.warmedPosTotal) },
        warmedNegTotal: { raw: engine.warmedNegTotal.toString(), sol: sol(engine.warmedNegTotal) },
        insuranceReserved: { raw: engine.warmupInsuranceReserved.toString(), sol: sol(engine.warmupInsuranceReserved) },
      },

      slots: {
        current: engine.currentSlot.toString(),
        lastFunding: engine.lastFundingSlot.toString(),
        lastCrank: engine.lastCrankSlot.toString(),
        maxCrankStaleness: engine.maxCrankStalenessSlots.toString(),
        lastSweepStart: engine.lastSweepStartSlot.toString(),
        lastSweepComplete: engine.lastSweepCompleteSlot.toString(),
      },

      funding: {
        indexQpbE6: engine.fundingIndexQpbE6.toString(),
      },

      openInterest: {
        totalUnits: engine.totalOpenInterest.toString(),
        totalSol: sol(engine.totalOpenInterest * oraclePrice / 1_000_000n),
      },

      lpAggregates: {
        netLpPos: engine.netLpPos.toString(),
        netLpPosSol: sol((engine.netLpPos < 0n ? -engine.netLpPos : engine.netLpPos) * oraclePrice / 1_000_000n),
        lpSumAbs: engine.lpSumAbs.toString(),
      },

      counters: {
        crankStep: engine.crankStep,
        lifetimeLiquidations: Number(engine.lifetimeLiquidations),
        lifetimeForceCloses: Number(engine.lifetimeForceCloses),
        numUsedAccounts: engine.numUsedAccounts,
        nextAccountId: engine.nextAccountId.toString(),
      },
    },

    oracle: {
      rawUsd: Number(oracleData.price) / Math.pow(10, oracleData.decimals),
      rawE6: rawOraclePriceE6.toString(),
      decimals: oracleData.decimals,
      inverted: config.invert === 1,
      effectivePriceE6: oraclePrice.toString(),
    },

    accounts,

    solvency: {
      vault: { raw: engine.vault.toString(), sol: sol(engine.vault) },
      totalCapital: { raw: totalCapital.toString(), sol: sol(totalCapital) },
      insurance: { raw: insurance.toString(), sol: sol(insurance) },
      totalClaims: { raw: (totalCapital + insurance).toString(), sol: sol(totalCapital + insurance) },
      surplus: { raw: (engine.vault - totalCapital - insurance).toString(), sol: sol(engine.vault - totalCapital - insurance) },
      solvent: engine.vault >= totalCapital + insurance,
      lossAccum: { raw: engine.lossAccum.toString(), sol: sol(engine.lossAccum) },
      strandedFunds: {
        raw: (engine.vault - totalCapital - insurance).toString(),
        sol: sol(engine.vault - totalCapital - insurance),
        note: "Vault balance minus all claims (capital + insurance). Positive value indicates funds with no current owner.",
      },
    },
  };

  fs.writeFileSync("market.json", JSON.stringify(toJSON(market), null, 2));
  console.log("Full market state dumped to market.json");
  console.log();
  console.log("  Slab:           " + SLAB.toBase58());
  console.log("  Accounts:       " + accounts.length);
  console.log("  Vault:          " + sol(engine.vault).toFixed(6) + " SOL");
  console.log("  Insurance:      " + sol(insurance).toFixed(6) + " SOL");
  console.log("  Loss accum:     " + sol(engine.lossAccum).toFixed(6) + " SOL");
  console.log("  Risk-reduction: " + engine.riskReductionOnly);
  console.log("  Stranded funds: " + sol(engine.vault - totalCapital - insurance).toFixed(6) + " SOL");
}

main().catch(console.error);
