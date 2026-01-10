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
    .description("Initialize a new market (Pyth Pull oracle)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--mint <pubkey>", "Collateral token mint")
    .requiredOption("--vault <pubkey>", "Collateral vault token account")
    .requiredOption("--index-feed-id <hex>", "Pyth index feed ID (64 hex chars, no 0x)")
    .requiredOption("--max-staleness-secs <string>", "Max oracle staleness (seconds)")
    .requiredOption("--conf-filter-bps <number>", "Oracle confidence filter (bps)")
    .option("--invert <number>", "Invert oracle price (0=no, 1=yes)", "0")
    .option("--unit-scale <number>", "Lamports per unit scale (0=no scaling)", "0")
    .requiredOption("--warmup-period <string>", "Warmup period (slots)")
    .requiredOption("--maintenance-margin-bps <string>", "Maintenance margin (bps)")
    .requiredOption("--initial-margin-bps <string>", "Initial margin (bps)")
    .requiredOption("--trading-fee-bps <string>", "Trading fee (bps)")
    .requiredOption("--max-accounts <string>", "Max accounts")
    .requiredOption("--new-account-fee <string>", "New account fee (u128)")
    .requiredOption("--risk-reduction-threshold <string>", "Risk reduction threshold (u128)")
    .requiredOption("--maintenance-fee-per-slot <string>", "Maintenance fee per slot (u128)")
    .requiredOption("--max-crank-staleness <string>", "Max crank staleness (slots)")
    .requiredOption("--liquidation-fee-bps <string>", "Liquidation fee (bps)")
    .requiredOption("--liquidation-fee-cap <string>", "Liquidation fee cap (u128)")
    .requiredOption("--liquidation-buffer-bps <string>", "Liquidation buffer (bps)")
    .requiredOption("--min-liquidation-abs <string>", "Min liquidation absolute (u128)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const mint = new PublicKey(opts.mint);
      const vault = new PublicKey(opts.vault);
      const indexFeedId = opts.indexFeedId;

      // Validate feed ID format
      const feedIdHex = indexFeedId.startsWith("0x") ? indexFeedId.slice(2) : indexFeedId;
      if (feedIdHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(feedIdHex)) {
        throw new Error("Invalid feed ID: must be 64 hex characters");
      }

      // Derive vault authority for dummy ATA lookup (unused but required)
      const [vaultPda] = deriveVaultAuthority(ctx.programId, slabPk);

      // Build instruction data
      const ixData = encodeInitMarket({
        admin: ctx.payer.publicKey,
        collateralMint: mint,
        indexFeedId: feedIdHex,
        maxStalenessSecs: opts.maxStalenessSecs,
        confFilterBps: parseInt(opts.confFilterBps, 10),
        invert: parseInt(opts.invert, 10),
        unitScale: parseInt(opts.unitScale, 10),
        warmupPeriodSlots: opts.warmupPeriod,
        maintenanceMarginBps: opts.maintenanceMarginBps,
        initialMarginBps: opts.initialMarginBps,
        tradingFeeBps: opts.tradingFeeBps,
        maxAccounts: opts.maxAccounts,
        newAccountFee: opts.newAccountFee,
        riskReductionThreshold: opts.riskReductionThreshold,
        maintenanceFeePerSlot: opts.maintenanceFeePerSlot,
        maxCrankStalenessSlots: opts.maxCrankStaleness,
        liquidationFeeBps: opts.liquidationFeeBps,
        liquidationFeeCap: opts.liquidationFeeCap,
        liquidationBufferBps: opts.liquidationBufferBps,
        minLiquidationAbs: opts.minLiquidationAbs,
      });

      // Build account metas (order matches ACCOUNTS_INIT_MARKET)
      const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
        ctx.payer.publicKey, // admin
        slabPk, // slab
        mint, // mint
        vault, // vault
        WELL_KNOWN.tokenProgram, // tokenProgram
        WELL_KNOWN.clock, // clock
        WELL_KNOWN.rent, // rent
        vaultPda, // dummyAta (unused, pass vault PDA)
        WELL_KNOWN.systemProgram, // systemProgram
      ]);

      const ix = buildIx({
        programId: ctx.programId,
        keys,
        data: ixData,
      });

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
