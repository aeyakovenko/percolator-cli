import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { deriveVaultAuthority } from "../solana/pda.js";
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
    .requiredOption("--index-feed-id <hex>", "Pyth index feed ID (64 hex chars, no 0x; all zeros for Hyperp)")
    .requiredOption("--max-staleness-secs <string>", "Max oracle staleness (seconds)")
    .requiredOption("--conf-filter-bps <number>", "Oracle confidence filter (bps)")
    .option("--invert <number>", "Invert oracle price (0=no, 1=yes)", "0")
    .option("--unit-scale <number>", "Lamports per unit scale (0=no scaling)", "0")
    .option("--initial-mark-price <string>", "Initial mark price e6 (required non-zero for Hyperp mode)", "0")
    .requiredOption("--maintenance-fee-per-slot <string>", "Periodic maintenance fee per slot per account (u128)")
    .requiredOption("--max-insurance-floor <string>", "Max insurance floor admin can set (u128, >0)")
    .option("--min-oracle-price-cap <string>", "Min oracle price cap e2bps floor (0=no floor)", "0")
    // RiskParams
    .requiredOption("--h-min <string>", "Warmup horizon floor (slots)")
    .requiredOption("--maintenance-margin-bps <string>", "Maintenance margin (bps)")
    .requiredOption("--initial-margin-bps <string>", "Initial margin (bps)")
    .requiredOption("--trading-fee-bps <string>", "Trading fee (bps)")
    .requiredOption("--max-accounts <string>", "Max accounts (must be <= 4096 power of two)")
    .requiredOption("--insurance-floor <string>", "Insurance floor (u128)")
    .requiredOption("--h-max <string>", "Warmup horizon ceiling (slots)")
    .requiredOption("--max-crank-staleness <string>", "Max crank staleness (slots)")
    .requiredOption("--liquidation-fee-bps <string>", "Liquidation fee (bps)")
    .requiredOption("--liquidation-fee-cap <string>", "Liquidation fee cap (u128)")
    .requiredOption("--resolve-price-deviation-bps <string>", "Resolve price deviation bound (bps)")
    .requiredOption("--min-liquidation-abs <string>", "Min liquidation absolute (u128)")
    .requiredOption("--min-initial-deposit <string>", "Min initial deposit (u128)")
    .requiredOption("--min-nonzero-mm-req <string>", "Min nonzero maintenance margin requirement (u128)")
    .requiredOption("--min-nonzero-im-req <string>", "Min nonzero initial margin requirement (u128)")
    // Extended tail (required — partial tail rejected)
    .requiredOption("--insurance-withdraw-max-bps <number>", "Max bps withdrawable from insurance per tx (0=disabled)")
    .requiredOption("--insurance-withdraw-cooldown <string>", "Insurance withdrawal cooldown (slots)")
    .requiredOption("--permissionless-resolve-stale <string>", "Slots of oracle staleness for permissionless resolve (0=disabled)")
    .requiredOption("--funding-horizon-slots <string>", "Funding horizon (slots)")
    .requiredOption("--funding-k-bps <string>", "Funding k (bps)")
    .requiredOption("--funding-max-premium-bps <string>", "Funding max premium (i64 bps)")
    .requiredOption("--funding-max-bps-per-slot <string>", "Funding max rate (i64 bps/slot)")
    .requiredOption("--mark-min-fee <string>", "Min fee for full mark weight (0=disabled)")
    .requiredOption("--force-close-delay <string>", "Force-close delay after resolve (slots)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const mint = new PublicKey(opts.mint);
      const vault = new PublicKey(opts.vault);

      const feedIdHex = (opts.indexFeedId as string).startsWith("0x")
        ? (opts.indexFeedId as string).slice(2)
        : (opts.indexFeedId as string);
      if (feedIdHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(feedIdHex)) {
        throw new Error("Invalid feed ID: must be 64 hex characters");
      }

      const [vaultPda] = deriveVaultAuthority(ctx.programId, slabPk);

      const ixData = encodeInitMarket({
        admin: ctx.payer.publicKey,
        collateralMint: mint,
        indexFeedId: feedIdHex,
        maxStalenessSecs: opts.maxStalenessSecs,
        confFilterBps: parseInt(opts.confFilterBps, 10),
        invert: parseInt(opts.invert, 10),
        unitScale: parseInt(opts.unitScale, 10),
        initialMarkPriceE6: opts.initialMarkPrice,
        maintenanceFeePerSlot: opts.maintenanceFeePerSlot,
        maxInsuranceFloor: opts.maxInsuranceFloor,
        minOraclePriceCapE2bps: opts.minOraclePriceCap,
        hMin: opts.hMin,
        maintenanceMarginBps: opts.maintenanceMarginBps,
        initialMarginBps: opts.initialMarginBps,
        tradingFeeBps: opts.tradingFeeBps,
        maxAccounts: opts.maxAccounts,
        insuranceFloor: opts.insuranceFloor,
        hMax: opts.hMax,
        maxCrankStalenessSlots: opts.maxCrankStaleness,
        liquidationFeeBps: opts.liquidationFeeBps,
        liquidationFeeCap: opts.liquidationFeeCap,
        resolvePriceDeviationBps: opts.resolvePriceDeviationBps,
        minLiquidationAbs: opts.minLiquidationAbs,
        minInitialDeposit: opts.minInitialDeposit,
        minNonzeroMmReq: opts.minNonzeroMmReq,
        minNonzeroImReq: opts.minNonzeroImReq,
        insuranceWithdrawMaxBps: parseInt(opts.insuranceWithdrawMaxBps, 10),
        insuranceWithdrawCooldownSlots: opts.insuranceWithdrawCooldown,
        permissionlessResolveStaleSlots: opts.permissionlessResolveStale,
        fundingHorizonSlots: opts.fundingHorizonSlots,
        fundingKBps: opts.fundingKBps,
        fundingMaxPremiumBps: opts.fundingMaxPremiumBps,
        fundingMaxBpsPerSlot: opts.fundingMaxBpsPerSlot,
        markMinFee: opts.markMinFee,
        forceCloseDelaySlots: opts.forceCloseDelay,
      });

      const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
        ctx.payer.publicKey, // admin
        slabPk,              // slab
        mint,                // mint
        vault,               // vault
        WELL_KNOWN.tokenProgram,
        WELL_KNOWN.clock,
        WELL_KNOWN.rent,
        vaultPda,            // placeholder (unused)
        WELL_KNOWN.systemProgram,
      ]);

      const ix = buildIx({ programId: ctx.programId, keys, data: ixData });

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers: [ctx.payer],
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
