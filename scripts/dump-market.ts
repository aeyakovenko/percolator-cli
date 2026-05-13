/**
 * Comprehensive market dump — every field the parser exposes, in JSON.
 *
 * Usage:
 *   npx tsx scripts/dump-market.ts --slab <pubkey> [--url <rpc>] [--out <path>]
 *
 * Defaults: --slab from devnet-market.json, --url devnet, --out market.json.
 *
 * Re-written for v12.21+ parser surface — older field names that no
 * longer exist (threshold pack, lifetimeLiquidations, warmupPeriodSlots,
 * lastSweepStartSlot, etc.) are gone from the dump.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchSlab, parseHeader, parseConfig, parseParams, parseEngine,
  parseAccount, parseUsedIndices, AccountKind, MarketMode, SideMode,
} from "../src/solana/slab.js";
import * as fs from "fs";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function loadDefaults(): { slab?: string; oracle?: string } {
  try {
    return JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
  } catch {
    return {};
  }
}

const sol = (n: bigint) => Number(n) / 1e9;

function toJSON(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(toJSON);
  if (obj && typeof obj === "object") {
    if (obj.toBase58) return obj.toBase58();
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) result[k] = toJSON(v);
    return result;
  }
  return obj;
}

async function main() {
  const defaults = loadDefaults();
  const slabArg = arg("--slab", defaults.slab);
  const url = arg("--url", "https://api.devnet.solana.com")!;
  const outPath = arg("--out", "market.json")!;
  if (!slabArg) {
    throw new Error("--slab <pubkey> required (or write devnet-market.json)");
  }

  const SLAB = new PublicKey(slabArg);
  const conn = new Connection(url, "confirmed");
  const data = await fetchSlab(conn, SLAB);
  const header = parseHeader(data);
  const config = parseConfig(data);
  const params = parseParams(data);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  const accounts = indices.map(idx => {
    const a = parseAccount(data, idx);
    return {
      idx,
      kind: a.kind === AccountKind.LP ? "LP" : "USER",
      owner: a.owner.toBase58(),
      capital: { raw: a.capital.toString(), sol: sol(a.capital) },
      pnl: { raw: a.pnl.toString(), sol: sol(a.pnl) },
      reservedPnl: { raw: a.reservedPnl.toString(), sol: sol(a.reservedPnl) },
      positionBasisQ: a.positionBasisQ.toString(),
      direction: a.positionBasisQ > 0n ? "LONG" : a.positionBasisQ < 0n ? "SHORT" : "FLAT",
      adlABasis: a.adlABasis.toString(),
      adlKSnap: a.adlKSnap.toString(),
      fSnap: a.fSnap.toString(),
      adlEpochSnap: a.adlEpochSnap.toString(),
      matcher: { program: a.matcherProgram.toBase58(), context: a.matcherContext.toBase58() },
      fees: { feeCredits: a.feeCredits.toString(), lastFeeSlot: a.lastFeeSlot.toString() },
      sched: a.schedPresent ? {
        remainingQ: a.schedRemainingQ.toString(),
        anchorQ: a.schedAnchorQ.toString(),
        startSlot: a.schedStartSlot.toString(),
        horizon: a.schedHorizon.toString(),
        releaseQ: a.schedReleaseQ.toString(),
      } : null,
      pending: a.pendingPresent ? {
        remainingQ: a.pendingRemainingQ.toString(),
        horizon: a.pendingHorizon.toString(),
        createdSlot: a.pendingCreatedSlot.toString(),
      } : null,
    };
  });

  let totalCapital = 0n;
  for (const idx of indices) totalCapital += parseAccount(data, idx).capital;

  const insurance = engine.insuranceFund.balance;
  const market = {
    _meta: {
      timestamp: new Date().toISOString(),
      slab: SLAB.toBase58(),
      slabDataBytes: data.length,
      rpc: url,
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
        kBps: config.fundingKBps.toString(),
        maxPremiumBps: config.fundingMaxPremiumBps.toString(),
        maxE9PerSlot: config.fundingMaxE9PerSlot.toString(),
      },

      hyperp: {
        authority: config.hyperpAuthority.toBase58(),
        markE6: config.hyperpMarkE6.toString(),
        lastIndexSlot: config.lastHyperpIndexSlot.toString(),
        lastMarkPushSlot: config.lastMarkPushSlot.toString(),
      },

      oracle: {
        lastPublishTime: config.lastOraclePublishTime.toString(),
        lastEffectivePriceE6: config.lastEffectivePriceE6.toString(),
        targetPriceE6: config.oracleTargetPriceE6.toString(),
        targetPublishTime: config.oracleTargetPublishTime.toString(),
        lastGoodOracleSlot: config.lastGoodOracleSlot.toString(),
        permissionlessResolveStaleSlots: config.permissionlessResolveStaleSlots.toString(),
      },

      insuranceWithdraw: {
        maxBpsRaw: config.insuranceWithdrawMaxBps,
        depositsOnlyFlag: (config.insuranceWithdrawMaxBps & 0x8000) !== 0,
        maxBps: config.insuranceWithdrawMaxBps & 0x7fff,
        depositsOnly: config.insuranceWithdrawDepositsOnly,
        cooldownSlots: config.insuranceWithdrawCooldownSlots.toString(),
        lastWithdrawSlot: config.lastInsuranceWithdrawSlot.toString(),
        depositRemaining: config.insuranceWithdrawDepositRemaining.toString(),
        tvlInsuranceCapMult: config.tvlInsuranceCapMult,
      },

      mark: {
        ewmaE6: config.markEwmaE6.toString(),
        ewmaLastSlot: config.markEwmaLastSlot.toString(),
        ewmaHalflifeSlots: config.markEwmaHalflifeSlots.toString(),
        minFee: config.markMinFee.toString(),
      },

      fees: {
        maintenanceFeePerSlot: config.maintenanceFeePerSlot.toString(),
        newAccountFee: { raw: config.newAccountFee.toString(), sol: sol(config.newAccountFee) },
        feeSweepCursorWord: config.feeSweepCursorWord.toString(),
        feeSweepCursorBit: config.feeSweepCursorBit.toString(),
      },

      lifecycle: {
        initRestartSlot: config.initRestartSlot.toString(),
        forceCloseDelaySlots: config.forceCloseDelaySlots.toString(),
      },
    },

    riskParams: {
      maintenanceMarginBps: params.maintenanceMarginBps.toString(),
      initialMarginBps: params.initialMarginBps.toString(),
      tradingFeeBps: params.tradingFeeBps.toString(),
      maxAccounts: params.maxAccounts.toString(),
      liquidationFeeBps: params.liquidationFeeBps.toString(),
      liquidationFeeCap: params.liquidationFeeCap.toString(),
      minLiquidationAbs: params.minLiquidationAbs.toString(),
      minNonzeroMmReq: params.minNonzeroMmReq.toString(),
      minNonzeroImReq: params.minNonzeroImReq.toString(),
      hMin: params.hMin.toString(),
      hMax: params.hMax.toString(),
      resolvePriceDeviationBps: params.resolvePriceDeviationBps.toString(),
      maxAccrualDtSlots: params.maxAccrualDtSlots.toString(),
      maxAbsFundingE9PerSlot: params.maxAbsFundingE9PerSlot.toString(),
      minFundingLifetimeSlots: params.minFundingLifetimeSlots.toString(),
      maxActivePositionsPerSide: params.maxActivePositionsPerSide.toString(),
      maxPriceMoveBpsPerSlot: params.maxPriceMoveBpsPerSlot.toString(),
    },

    engine: {
      marketMode: engine.marketMode === MarketMode.Live ? "Live" : "Resolved",
      vault: { raw: engine.vault.toString(), sol: sol(engine.vault) },
      insurance: { raw: insurance.toString(), sol: sol(insurance) },
      cTot: { raw: engine.cTot.toString(), sol: sol(engine.cTot) },
      pnlPosTot: engine.pnlPosTot.toString(),
      pnlMaturedPosTot: engine.pnlMaturedPosTot.toString(),
      currentSlot: engine.currentSlot.toString(),
      lastMarketSlot: engine.lastMarketSlot.toString(),
      lastOraclePrice: engine.lastOraclePrice.toString(),
      fundPxLast: engine.fundPxLast.toString(),
      counters: {
        numUsedAccounts: engine.numUsedAccounts,
        materializedAccountCount: engine.materializedAccountCount.toString(),
        negPnlAccountCount: engine.negPnlAccountCount.toString(),
      },
      sweep: {
        rrCursorPosition: engine.rrCursorPosition.toString(),
        sweepGeneration: engine.sweepGeneration.toString(),
        stressConsumedBpsE9SinceEnvelope: engine.stressConsumedBpsE9SinceEnvelope.toString(),
      },
      sides: {
        long: {
          mode: SideMode[engine.sideModeLong],
          oiEffQ: engine.oiEffLongQ.toString(),
          storedPosCount: engine.storedPosCountLong.toString(),
          staleAccountCount: engine.staleAccountCountLong.toString(),
          phantomDustBoundQ: engine.phantomDustBoundLongQ.toString(),
          fNum: engine.fLongNum.toString(),
          fEpochStartNum: engine.fEpochStartLongNum.toString(),
          adlMult: engine.adlMultLong.toString(),
          adlCoeff: engine.adlCoeffLong.toString(),
          adlEpoch: engine.adlEpochLong.toString(),
          adlEpochStartK: engine.adlEpochStartKLong.toString(),
        },
        short: {
          mode: SideMode[engine.sideModeShort],
          oiEffQ: engine.oiEffShortQ.toString(),
          storedPosCount: engine.storedPosCountShort.toString(),
          staleAccountCount: engine.staleAccountCountShort.toString(),
          phantomDustBoundQ: engine.phantomDustBoundShortQ.toString(),
          fNum: engine.fShortNum.toString(),
          fEpochStartNum: engine.fEpochStartShortNum.toString(),
          adlMult: engine.adlMultShort.toString(),
          adlCoeff: engine.adlCoeffShort.toString(),
          adlEpoch: engine.adlEpochShort.toString(),
          adlEpochStartK: engine.adlEpochStartKShort.toString(),
        },
      },
      resolution: {
        price: engine.resolvedPrice.toString(),
        slot: engine.resolvedSlot.toString(),
        livePrice: engine.resolvedLivePrice.toString(),
        payoutHNum: engine.resolvedPayoutHNum.toString(),
        payoutHDen: engine.resolvedPayoutHDen.toString(),
        payoutReady: engine.resolvedPayoutReady,
        kLongTerminalDelta: engine.resolvedKLongTerminalDelta.toString(),
        kShortTerminalDelta: engine.resolvedKShortTerminalDelta.toString(),
      },
    },

    accounts,

    solvency: {
      vault: sol(engine.vault),
      totalCapital: sol(totalCapital),
      insurance: sol(insurance),
      cTot: sol(engine.cTot),
      stranded: sol(engine.vault - engine.cTot - insurance),
      vaultGteCTotPlusInsurance: engine.vault >= engine.cTot + insurance,
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(toJSON(market), null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(`  Slab:           ${SLAB.toBase58()}`);
  console.log(`  Mode:           ${market.engine.marketMode}`);
  console.log(`  Used accounts:  ${engine.numUsedAccounts}`);
  console.log(`  Vault:          ${sol(engine.vault).toFixed(6)} SOL`);
  console.log(`  Insurance:      ${sol(insurance).toFixed(6)} SOL`);
  console.log(`  cTot:           ${sol(engine.cTot).toFixed(6)} SOL`);
  console.log(`  Solvent:        ${market.solvency.vaultGteCTotPlusInsurance}`);
}

main().catch(e => { console.error(e); process.exit(1); });
