import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeInitMarket } from "../abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerInitMarket(program: Command): void {
  program
    .command("init-market")
    .description("Initialize a new market (Pyth Pull oracle; Hyperp when index feed is zero)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--mint <pubkey>", "Collateral token mint")
    .requiredOption("--vault <pubkey>", "Collateral vault token account")
    .requiredOption("--oracle <pubkey>", "Oracle account (Pyth PriceUpdateV2 / Chainlink aggregator; for Hyperp pass any pubkey)")
    .requiredOption("--index-feed-id <hex>", "Pyth index feed ID (64 hex chars, no 0x; all zeros for Hyperp)")
    .requiredOption("--max-staleness-secs <string>", "Max oracle staleness (seconds)")
    .requiredOption("--conf-filter-bps <number>", "Oracle confidence filter (bps)")
    .option("--invert <number>", "Invert oracle price (0=no, 1=yes)", "0")
    .option("--unit-scale <number>", "Lamports per unit scale (0=no scaling)", "0")
    .option("--initial-mark-price <string>", "Initial mark price e6 (required non-zero for Hyperp mode)", "0")
    .requiredOption("--maintenance-fee-per-slot <string>", "Periodic maintenance fee per slot per account (u128)")
    // RiskParams
    .requiredOption("--h-min <string>", "Warmup horizon floor (slots)")
    .requiredOption("--maintenance-margin-bps <string>", "Maintenance margin (bps)")
    .requiredOption("--initial-margin-bps <string>", "Initial margin (bps)")
    .requiredOption("--trading-fee-bps <string>", "Trading fee (bps)")
    .requiredOption("--max-accounts <string>", "Max accounts (must be <= 4096 power of two)")
    .requiredOption("--new-account-fee <string>", "New-account init fee, insurance-destined (u128; v12.20+)")
    .requiredOption("--h-max <string>", "Warmup horizon ceiling (slots)")
    .requiredOption("--max-crank-staleness <string>", "Max crank staleness (slots)")
    .requiredOption("--liquidation-fee-bps <string>", "Liquidation fee (bps)")
    .requiredOption("--liquidation-fee-cap <string>", "Liquidation fee cap (u128)")
    .requiredOption("--resolve-price-deviation-bps <string>", "Resolve price deviation bound (bps)")
    .requiredOption("--min-liquidation-abs <string>", "Min liquidation absolute (u128)")
    .requiredOption("--min-nonzero-mm-req <string>", "Min nonzero maintenance margin requirement (u128)")
    .requiredOption("--min-nonzero-im-req <string>", "Min nonzero initial margin requirement (u128)")
    .requiredOption("--max-price-move-bps-per-slot <string>", "Per-slot price-move cap in bps (v12.21+, must be > 0)")
    // Extended tail (required — partial tail rejected)
    .requiredOption("--insurance-withdraw-max-bps <number>", "Max bps withdrawable from insurance per tx (0=disabled)")
    .requiredOption("--insurance-withdraw-cooldown <string>", "Insurance withdrawal cooldown (slots)")
    .requiredOption("--permissionless-resolve-stale <string>", "Slots of oracle staleness for permissionless resolve (0=disabled)")
    .requiredOption("--funding-horizon-slots <string>", "Funding horizon (slots)")
    .requiredOption("--funding-k-bps <string>", "Funding k (bps)")
    .requiredOption("--funding-max-premium-bps <string>", "Funding max premium (i64 bps)")
    .requiredOption("--funding-max-e9-per-slot <string>", "Funding max rate (i64 e9 parts-per-billion per slot; v12.18+)")
    .requiredOption("--mark-min-fee <string>", "Min fee for full mark weight (0=disabled)")
    .requiredOption("--force-close-delay <string>", "Force-close delay after resolve (slots)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const mint = validatePublicKey(opts.mint, "--mint");
      const vault = validatePublicKey(opts.vault, "--vault");
      const oracle = validatePublicKey(opts.oracle, "--oracle");

      const feedIdHex = (opts.indexFeedId as string).startsWith("0x")
        ? (opts.indexFeedId as string).slice(2)
        : (opts.indexFeedId as string);
      if (feedIdHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(feedIdHex)) {
        throw new Error("Invalid feed ID: must be 64 hex characters");
      }

      // Validate numeric parameters
      const maxStalenessSecs = validateU64(opts.maxStalenessSecs, "--max-staleness-secs");
      const confFilterBps = validateBps(opts.confFilterBps, "--conf-filter-bps");
      const invert = validateU16(opts.invert, "--invert");
      const unitScale = validateU16(opts.unitScale, "--unit-scale");
      const initialMarkPriceE6 = validateU64(opts.initialMarkPrice, "--initial-mark-price");
      const maintenanceFeePerSlot = validateU128(opts.maintenanceFeePerSlot, "--maintenance-fee-per-slot");
      const hMin = validateU64(opts.hMin, "--h-min");
      const maintenanceMarginBps = validateBps(opts.maintenanceMarginBps, "--maintenance-margin-bps");
      const initialMarginBps = validateBps(opts.initialMarginBps, "--initial-margin-bps");
      const tradingFeeBps = validateBps(opts.tradingFeeBps, "--trading-fee-bps");
      const maxAccounts = validateU64(opts.maxAccounts, "--max-accounts");
      const newAccountFee = validateU128(opts.newAccountFee, "--new-account-fee");
      const hMax = validateU64(opts.hMax, "--h-max");
      const maxCrankStalenessSlots = validateU64(opts.maxCrankStaleness, "--max-crank-staleness");
      const liquidationFeeBps = validateBps(opts.liquidationFeeBps, "--liquidation-fee-bps");
      const liquidationFeeCap = validateU128(opts.liquidationFeeCap, "--liquidation-fee-cap");
      const resolvePriceDeviationBps = validateBps(opts.resolvePriceDeviationBps, "--resolve-price-deviation-bps");
      const minLiquidationAbs = validateU128(opts.minLiquidationAbs, "--min-liquidation-abs");
      const minNonzeroMmReq = validateU128(opts.minNonzeroMmReq, "--min-nonzero-mm-req");
      const minNonzeroImReq = validateU128(opts.minNonzeroImReq, "--min-nzero-im-req");
      const maxPriceMoveBpsPerSlot = validateBps(opts.maxPriceMoveBpsPerSlot, "--max-price-move-bps-per-slot");
      const insuranceWithdrawMaxBps = validateBps(opts.insuranceWithdrawMaxBps, "--insurance-withdraw-max-bps");
      const insuranceWithdrawCooldownSlots = validateU64(opts.insuranceWithdrawCooldown, "--insurance-withdraw-cooldown");
      const permissionlessResolveStaleSlots = validateU64(opts.permissionlessResolveStale, "--permissionless-resolve-stale");
      const fundingHorizonSlots = validateU64(opts.fundingHorizonSlots, "--funding-horizon-slots");
      const fundingKBps = validateU64(opts.fundingKBps, "--funding-k-bps");
      const fundingMaxPremiumBps = validateU64(opts.fundingMaxPremiumBps, "--funding-max-premium-bps");
      const fundingMaxE9PerSlot = validateU64(opts.fundingMaxE9PerSlot, "--funding-max-e9-per-slot");
      const markMinFee = validateU64(opts.markMinFee, "--mark-min-fee");
      const forceCloseDelaySlots = validateU64(opts.forceCloseDelay, "--force-close-delay");

      const ixData = encodeInitMarket({
        admin: ctx.payer.publicKey,
        collateralMint: mint,
        indexFeedId: feedIdHex,
        maxStalenessSecs,
        confFilterBps,
        invert,
        unitScale,
        initialMarkPriceE6,
        maintenanceFeePerSlot,
        hMin,
        maintenanceMarginBps,
        initialMarginBps,
        tradingFeeBps,
        maxAccounts,
        newAccountFee,
        hMax,
        maxCrankStalenessSlots,
        liquidationFeeBps,
        liquidationFeeCap,
        resolvePriceDeviationBps,
        minLiquidationAbs,
        minNonzeroMmReq,
        minNonzeroImReq,
        maxPriceMoveBpsPerSlot,
        insuranceWithdrawMaxBps,
        insuranceWithdrawCooldownSlots,
        permissionlessResolveStaleSlots,
        fundingHorizonSlots,
        fundingKBps,
        fundingMaxPremiumBps,
        fundingMaxE9PerSlot,
        markMinFee,
        forceCloseDelaySlots,
      });

      const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
        ctx.payer.publicKey, // admin
        slabPk,              // slab
        mint,                // mint
        vault,               // vault
        WELL_KNOWN.clock,
        oracle,
      ]);

      const ix = buildIx({ programId: ctx.programId, keys, data: ixData });

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers: [ctx.payer],
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
        // Full MAX_ACCOUNTS=4096 init_in_place consumes ~235k CU zero-filling
        // bitmap + next_free/prev_free + all 4096 account slots. Default
        // 200k-per-ix budget is not enough; 300k covers + headroom.
        computeUnitLimit: 300_000,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
