/**
 * Comprehensive market dump — ALL on-chain data structures to market.json
 *
 * Usage:
 *   npx tsx scripts/dump-market.ts [--slab <pubkey>] [--url <rpc>]
 *
 * If --slab is omitted, falls back to devnet-market.json in cwd.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchSlab, parseHeader, parseConfig, parseParams, parseEngine,
  parseAccount, parseUsedIndices, AccountKind, MarketMode, SideMode,
} from "../src/solana/slab.js";
import * as fs from "fs";

// ---------------- CLI args ----------------
function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const argSlab = getArg("slab");
const argUrl = getArg("url");

let SLAB: PublicKey;
let ORACLE: PublicKey | null = null;
if (argSlab) {
  SLAB = new PublicKey(argSlab);
} else {
  const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
  SLAB = new PublicKey(marketInfo.slab);
  if (marketInfo.oracle) ORACLE = new PublicKey(marketInfo.oracle);
}
const RPC_URL = argUrl ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// ---------------- helpers ----------------
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
const marketModeStr = (m: MarketMode) => m === MarketMode.Resolved ? "Resolved" : "Live";
const sideModeStr = (m: SideMode) =>
  m === SideMode.Normal ? "Normal" : m === SideMode.DrainOnly ? "DrainOnly" : "ResetPending";

async function getChainlinkPrice(oracle: PublicKey): Promise<{ price: bigint; decimals: number } | null> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) return null;
  try {
    return { price: info.data.readBigInt64LE(216), decimals: info.data.readUInt8(138) };
  } catch {
    return null;
  }
}

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const header = parseHeader(data);
  const config = parseConfig(data);
  const params = parseParams(data);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  // Oracle — only if we have an oracle pubkey (from devnet-market.json).
  // For live mainnet slabs we may not have it; effectivePrice falls back to
  // engine.lastOraclePrice.
  let rawOraclePriceE6 = 0n;
  let oraclePriceE6 = 0n;
  let oracleData: { price: bigint; decimals: number } | null = null;
  if (ORACLE) {
    oracleData = await getChainlinkPrice(ORACLE);
    if (oracleData) {
      rawOraclePriceE6 = oracleData.price * 1_000_000n / BigInt(10 ** oracleData.decimals);
      oraclePriceE6 = rawOraclePriceE6 > 0n ? 1_000_000_000_000n / rawOraclePriceE6 : 0n;
    }
  }
  // Fallback to engine's last observed oracle price.
  if (oraclePriceE6 === 0n) oraclePriceE6 = engine.lastOraclePrice;

  const insurance = engine.insuranceFund.balance;

  // Build accounts
  const accounts = indices.map(idx => {
    const acc = parseAccount(data, idx);
    if (!acc) return null;

    const posAbs = acc.positionBasisQ < 0n ? -acc.positionBasisQ : acc.positionBasisQ;
    const notional = posAbs * oraclePriceE6 / 1_000_000n;
    const effectiveCapital = acc.capital + acc.pnl;
    const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;
    const marginRatioBps = notional > 0n ? effectiveCapital * 10_000n / notional : 99999n;

    return {
      index: idx,
      kind: acc.kind === AccountKind.LP ? "LP" : "USER",
      // accountId: field removed in current slab version — index IS the id
      owner: acc.owner.toBase58(),

      capital: { raw: acc.capital.toString(), sol: sol(acc.capital) },
      pnl: { realized: { raw: acc.pnl.toString(), sol: sol(acc.pnl) } },
      effectiveCapital: { raw: effectiveCapital.toString(), sol: sol(effectiveCapital) },

      warmup: {
        // warmup is now tracked by sched_*/pending_* buckets, not warmup_started_at_slot
        reservedPnl: { raw: acc.reservedPnl.toString(), sol: sol(acc.reservedPnl) },
        schedPresent: acc.schedPresent,
        schedRemainingQ: acc.schedRemainingQ.toString(),
        schedStartSlot: acc.schedStartSlot.toString(),
        schedHorizonSlots: acc.schedHorizon.toString(),
        pendingPresent: acc.pendingPresent,
        pendingRemainingQ: acc.pendingRemainingQ.toString(),
        pendingHorizonSlots: acc.pendingHorizon.toString(),
      },

      position: {
        sizeUnitsQ: acc.positionBasisQ.toString(),
        direction: acc.positionBasisQ > 0n ? "LONG" : acc.positionBasisQ < 0n ? "SHORT" : "FLAT",
        adlABasis: acc.adlABasis.toString(),
        adlKSnap: acc.adlKSnap.toString(),
        adlEpochSnap: acc.adlEpochSnap.toString(),
        notional: { raw: notional.toString(), sol: sol(notional) },
      },

      margin: {
        maintenanceRequired: { raw: maintenanceReq.toString(), sol: sol(maintenanceReq) },
        ratioPercent: Number(marginRatioBps) / 100,
        buffer: { raw: (effectiveCapital - maintenanceReq).toString(), sol: sol(effectiveCapital - maintenanceReq) },
        status: effectiveCapital < maintenanceReq ? "LIQUIDATABLE"
          : marginRatioBps < params.maintenanceMarginBps * 2n ? "AT_RISK" : "SAFE",
      },

      funding: { fSnap: acc.fSnap.toString() },

      matcher: {
        program: acc.matcherProgram.toBase58(),
        context: acc.matcherContext.toBase58(),
      },

      fees: {
        feeCredits: acc.feeCredits.toString(),
        lastFeeSlot: acc.lastFeeSlot.toString(),
      },
    };
  }).filter(Boolean) as any[];

  const activePositions = accounts.filter(a => a.position.direction !== "FLAT").length;

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
      oracleAddress: ORACLE ? ORACLE.toBase58() : null,
      rpcUrl: RPC_URL,
      slabDataBytes: data.length,
    },

    header: {
      magic: header.magic.toString(16),
      version: header.version,
      bump: header.bump,
      flags: header.flags,
      admin: header.admin.toBase58(),
      insuranceAuthority: header.insuranceAuthority.toBase58(),
      insuranceOperator: header.insuranceOperator.toBase58(),
      nonce: header.nonce.toString(),
      matCounter: header.matCounter.toString(),
      // lastThrUpdateSlot: field removed in current slab version
    },

    config: {
      collateralMint: config.collateralMint.toBase58(),
      vault: config.vaultPubkey.toBase58(),
      indexFeedId: config.indexFeedId.toBase58(),
      maxStalenessSecs: config.maxStalenessSecs.toString(),
      confFilterBps: config.confFilterBps,
      vaultAuthorityBump: config.vaultAuthorityBump,
      invert: config.invert,
      unitScale: config.unitScale,

      funding: {
        horizonSlots: config.fundingHorizonSlots.toString(),
        kBps: Number(config.fundingKBps),
        // invScaleNotionalE6: field removed in current slab version
        maxPremiumBps: Number(config.fundingMaxPremiumBps),
        maxE9PerSlot: Number(config.fundingMaxE9PerSlot),
      },

      // All threshold fields removed in current slab version (insurance floor
      // replaced by tvl_insurance_cap_mult + insurance_withdraw_max_bps gating).
      insuranceWithdraw: {
        maxBps: config.insuranceWithdrawMaxBps,
        cooldownSlots: config.insuranceWithdrawCooldownSlots.toString(),
        lastWithdrawSlot: config.lastInsuranceWithdrawSlot.toString(),
        tvlInsuranceCapMult: config.tvlInsuranceCapMult,
      },

      hyperp: {
        // oracleAuthority → hyperpAuthority; authorityPriceE6 → hyperpMarkE6;
        // authorityTimestamp → lastOraclePublishTime
        hyperpAuthority: config.hyperpAuthority.toBase58(),
        hyperpMarkE6: config.hyperpMarkE6.toString(),
        lastOraclePublishTime: config.lastOraclePublishTime.toString(),
        lastHyperpIndexSlot: config.lastHyperpIndexSlot.toString(),
        lastMarkPushSlot: config.lastMarkPushSlot.toString(),
      },

      priceCaps: {
        oraclePriceCapE2bps: config.oraclePriceCapE2bps.toString(),
        minOraclePriceCapE2bps: config.minOraclePriceCapE2bps.toString(),
        lastEffectivePriceE6: config.lastEffectivePriceE6.toString(),
      },

      mark: {
        markEwmaE6: config.markEwmaE6.toString(),
        markEwmaLastSlot: config.markEwmaLastSlot.toString(),
        markEwmaHalflifeSlots: config.markEwmaHalflifeSlots.toString(),
        markMinFee: config.markMinFee.toString(),
      },

      resolve: {
        initRestartSlot: config.initRestartSlot.toString(),
        permissionlessResolveStaleSlots: config.permissionlessResolveStaleSlots.toString(),
        lastGoodOracleSlot: config.lastGoodOracleSlot.toString(),
        forceCloseDelaySlots: config.forceCloseDelaySlots.toString(),
      },

      fees: {
        maintenanceFeePerSlot: { raw: config.maintenanceFeePerSlot.toString(), sol: sol(config.maintenanceFeePerSlot) },
        newAccountFee: { raw: config.newAccountFee.toString(), sol: sol(config.newAccountFee) },
        feeSweepCursorWord: config.feeSweepCursorWord.toString(),
        feeSweepCursorBit: config.feeSweepCursorBit.toString(),
      },
    },

    riskParams: {
      // warmupPeriodSlots: field removed — warmup is now per-account via sched/pending
      //                    horizons and maxAccrualDtSlots bounds the crank step.
      maxAccrualDtSlots: params.maxAccrualDtSlots.toString(),
      minFundingLifetimeSlots: params.minFundingLifetimeSlots.toString(),
      maintenanceMarginBps: Number(params.maintenanceMarginBps),
      maintenanceMarginPercent: pct(params.maintenanceMarginBps),
      initialMarginBps: Number(params.initialMarginBps),
      initialMarginPercent: pct(params.initialMarginBps),
      tradingFeeBps: Number(params.tradingFeeBps),
      maxAccounts: params.maxAccounts.toString(),
      maxActivePositionsPerSide: params.maxActivePositionsPerSide.toString(),
      // newAccountFee + maintenanceFeePerSlot moved to MarketConfig — see config.fees
      maxCrankStalenessSlots: params.maxCrankStalenessSlots.toString(),
      liquidationFeeBps: Number(params.liquidationFeeBps),
      liquidationFeePercent: pct(params.liquidationFeeBps),
      liquidationFeeCap: { raw: params.liquidationFeeCap.toString(), sol: sol(params.liquidationFeeCap) },
      minLiquidationAbs: { raw: params.minLiquidationAbs.toString(), sol: sol(params.minLiquidationAbs) },
      minNonzeroMmReq: params.minNonzeroMmReq.toString(),
      minNonzeroImReq: params.minNonzeroImReq.toString(),
      hMin: params.hMin.toString(),
      hMax: params.hMax.toString(),
      resolvePriceDeviationBps: Number(params.resolvePriceDeviationBps),
      maxAbsFundingE9PerSlot: params.maxAbsFundingE9PerSlot.toString(),
    },

    engine: {
      vault: { raw: engine.vault.toString(), sol: sol(engine.vault) },
      insuranceFund: { balance: { raw: insurance.toString(), sol: sol(insurance) } },

      marketMode: marketModeStr(engine.marketMode),
      resolved: {
        price: engine.resolvedPrice.toString(),
        slot: engine.resolvedSlot.toString(),
        payoutReady: engine.resolvedPayoutReady,
        payoutHNum: engine.resolvedPayoutHNum.toString(),
        payoutHDen: engine.resolvedPayoutHDen.toString(),
        kLongTerminalDelta: engine.resolvedKLongTerminalDelta.toString(),
        kShortTerminalDelta: engine.resolvedKShortTerminalDelta.toString(),
        livePrice: engine.resolvedLivePrice.toString(),
      },

      slots: {
        current: engine.currentSlot.toString(),
        lastCrank: engine.lastCrankSlot.toString(),
        lastMarket: engine.lastMarketSlot.toString(),
        // maxCrankStalenessSlots lives on RiskParams — see riskParams
        // lastSweepStart/Complete: fields removed in current slab version
      },

      capitalAccounting: {
        cTot: { raw: engine.cTot.toString(), sol: sol(engine.cTot) },
        pnlPosTot: engine.pnlPosTot.toString(),
        pnlMaturedPosTot: engine.pnlMaturedPosTot.toString(),
      },

      oi: {
        effLongQ: engine.oiEffLongQ.toString(),
        effShortQ: engine.oiEffShortQ.toString(),
        storedPosCountLong: engine.storedPosCountLong.toString(),
        storedPosCountShort: engine.storedPosCountShort.toString(),
        staleAccountCountLong: engine.staleAccountCountLong.toString(),
        staleAccountCountShort: engine.staleAccountCountShort.toString(),
        phantomDustBoundLongQ: engine.phantomDustBoundLongQ.toString(),
        phantomDustBoundShortQ: engine.phantomDustBoundShortQ.toString(),
      },

      adl: {
        multLong: engine.adlMultLong.toString(),
        multShort: engine.adlMultShort.toString(),
        coeffLong: engine.adlCoeffLong.toString(),
        coeffShort: engine.adlCoeffShort.toString(),
        epochLong: engine.adlEpochLong.toString(),
        epochShort: engine.adlEpochShort.toString(),
        epochStartKLong: engine.adlEpochStartKLong.toString(),
        epochStartKShort: engine.adlEpochStartKShort.toString(),
      },

      sideMode: {
        long: sideModeStr(engine.sideModeLong),
        short: sideModeStr(engine.sideModeShort),
      },

      funding: {
        // fundingRateBpsPerSlotLast: field removed; use f_*_num accumulators
        fLongNum: engine.fLongNum.toString(),
        fShortNum: engine.fShortNum.toString(),
        fEpochStartLongNum: engine.fEpochStartLongNum.toString(),
        fEpochStartShortNum: engine.fEpochStartShortNum.toString(),
        fundPxLast: engine.fundPxLast.toString(),
        lastOraclePrice: engine.lastOraclePrice.toString(),
      },

      counters: {
        // lifetimeLiquidations, nextAccountId: fields removed in current slab version
        numUsedAccounts: engine.numUsedAccounts,
        materializedAccountCount: engine.materializedAccountCount.toString(),
        negPnlAccountCount: engine.negPnlAccountCount.toString(),
        gcCursor: engine.gcCursor,
      },
    },

    oracle: oracleData ? {
      rawUsd: Number(oracleData.price) / Math.pow(10, oracleData.decimals),
      rawE6: rawOraclePriceE6.toString(),
      decimals: oracleData.decimals,
      inverted: config.invert === 1,
      effectivePriceE6: oraclePriceE6.toString(),
    } : {
      note: "No oracle pubkey supplied; using engine.lastOraclePrice for marks.",
      effectivePriceE6: oraclePriceE6.toString(),
      inverted: config.invert === 1,
    },

    accounts,

    summary: {
      numUsedAccounts: engine.numUsedAccounts,
      activePositions,
    },

    solvency: {
      vault: { raw: engine.vault.toString(), sol: sol(engine.vault) },
      totalCapital: { raw: totalCapital.toString(), sol: sol(totalCapital) },
      insurance: { raw: insurance.toString(), sol: sol(insurance) },
      totalClaims: { raw: (totalCapital + insurance).toString(), sol: sol(totalCapital + insurance) },
      surplus: { raw: (engine.vault - totalCapital - insurance).toString(), sol: sol(engine.vault - totalCapital - insurance) },
      solvent: engine.vault >= totalCapital + insurance,
    },
  };

  fs.writeFileSync("market.json", JSON.stringify(toJSON(market), null, 2));
  console.log("Full market state dumped to market.json");
  console.log();
  console.log("  Slab:              " + SLAB.toBase58());
  console.log("  RPC:               " + RPC_URL);
  console.log("  Version:           " + header.version);
  console.log("  MarketMode:        " + marketModeStr(engine.marketMode));
  console.log("  Accounts (used):   " + engine.numUsedAccounts);
  console.log("  Active positions:  " + activePositions);
  console.log("  Vault:             " + sol(engine.vault).toFixed(6) + " SOL");
  console.log("  Insurance:         " + sol(insurance).toFixed(6) + " SOL");
  console.log("  MaintFee/slot:     " + config.maintenanceFeePerSlot.toString());
  console.log("  NewAccountFee:     " + config.newAccountFee.toString());
  console.log("  fundingKBps:       " + config.fundingKBps.toString());
  console.log("  fundingHorizon:    " + config.fundingHorizonSlots.toString() + " slots");
  console.log("  MM / IM bps:       " + params.maintenanceMarginBps + " / " + params.initialMarginBps);
  console.log("  tradingFeeBps:     " + params.tradingFeeBps.toString());
  console.log("  maxAccounts:       " + params.maxAccounts.toString());
  console.log("  maxActivePosSide:  " + params.maxActivePositionsPerSide.toString());
  console.log("  permResolveStale:  " + config.permissionlessResolveStaleSlots.toString() + " slots");
  console.log("  LastCrankSlot:     " + engine.lastCrankSlot.toString());
  console.log("  CurrentSlot:       " + engine.currentSlot.toString());
  console.log("  cTot:              " + sol(engine.cTot).toFixed(6) + " SOL");
  console.log("  Stranded:          " + sol(engine.vault - totalCapital - insurance).toFixed(6) + " SOL");
}

main().catch(e => { console.error(e); process.exit(1); });
