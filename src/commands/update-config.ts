import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { encodeUpdateConfig } from "../abi/instructions.js";
import {
  ACCOUNTS_UPDATE_CONFIG,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

export function registerUpdateConfig(program: Command): void {
  program
    .command("update-config")
    .description("Update funding and threshold parameters (admin only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    // Funding parameters
    .option("--funding-horizon-slots <n>", "Funding horizon in slots (unchanged if omitted)")
    .option("--funding-k-bps <n>", "Funding multiplier in bps (unchanged if omitted)")
    .option("--funding-scale <n>", "Funding inventory scale notional e6 (unchanged if omitted)")
    .option("--funding-max-premium-bps <n>", "Max funding premium in bps (unchanged if omitted)")
    .option("--funding-max-bps-per-slot <n>", "Max funding rate per slot in bps (unchanged if omitted)")
    // Threshold parameters
    .option("--thresh-floor <n>", "Threshold floor (unchanged if omitted)")
    .option("--thresh-risk-bps <n>", "Threshold risk coefficient in bps (unchanged if omitted)")
    .option("--thresh-update-interval <n>", "Threshold update interval in slots (unchanged if omitted)")
    .option("--thresh-step-bps <n>", "Max threshold step in bps (unchanged if omitted)")
    .option("--thresh-alpha-bps <n>", "Threshold EWMA alpha in bps (unchanged if omitted)")
    .option("--thresh-min <n>", "Minimum threshold (unchanged if omitted)")
    .option("--thresh-max <n>", "Maximum threshold (unchanged if omitted)")
    .option("--thresh-min-step <n>", "Minimum threshold step (unchanged if omitted)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Fetch current on-chain config so unspecified params keep their current values
      const slabData = await fetchSlab(ctx.connection, slabPk);
      const current = parseConfig(slabData);

      // Build config: use current on-chain values as base, override only what the user provides
      const configArgs = {
        fundingHorizonSlots: opts.fundingHorizonSlots !== undefined ? BigInt(opts.fundingHorizonSlots) : current.fundingHorizonSlots,
        fundingKBps: opts.fundingKBps !== undefined ? BigInt(opts.fundingKBps) : current.fundingKBps,
        fundingInvScaleNotionalE6: opts.fundingScale !== undefined ? BigInt(opts.fundingScale) : current.fundingInvScaleNotionalE6,
        fundingMaxPremiumBps: opts.fundingMaxPremiumBps !== undefined ? BigInt(opts.fundingMaxPremiumBps) : current.fundingMaxPremiumBps,
        fundingMaxBpsPerSlot: opts.fundingMaxBpsPerSlot !== undefined ? BigInt(opts.fundingMaxBpsPerSlot) : current.fundingMaxBpsPerSlot,
        threshFloor: opts.threshFloor !== undefined ? BigInt(opts.threshFloor) : current.threshFloor,
        threshRiskBps: opts.threshRiskBps !== undefined ? BigInt(opts.threshRiskBps) : current.threshRiskBps,
        threshUpdateIntervalSlots: opts.threshUpdateInterval !== undefined ? BigInt(opts.threshUpdateInterval) : current.threshUpdateIntervalSlots,
        threshStepBps: opts.threshStepBps !== undefined ? BigInt(opts.threshStepBps) : current.threshStepBps,
        threshAlphaBps: opts.threshAlphaBps !== undefined ? BigInt(opts.threshAlphaBps) : current.threshAlphaBps,
        threshMin: opts.threshMin !== undefined ? BigInt(opts.threshMin) : current.threshMin,
        threshMax: opts.threshMax !== undefined ? BigInt(opts.threshMax) : current.threshMax,
        threshMinStep: opts.threshMinStep !== undefined ? BigInt(opts.threshMinStep) : current.threshMinStep,
      };

      const ixData = encodeUpdateConfig(configArgs);

      const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
        ctx.payer.publicKey, // admin
        slabPk, // slab
        WELL_KNOWN.clock, // clock
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

      if (!flags.json) {
        console.log("Config updated:");
        console.log(`  Funding Horizon:     ${configArgs.fundingHorizonSlots} slots`);
        console.log(`  Funding K:           ${configArgs.fundingKBps} bps`);
        console.log(`  Funding Scale:       ${configArgs.fundingInvScaleNotionalE6}`);
        console.log(`  Funding Max Premium: ${configArgs.fundingMaxPremiumBps} bps`);
        console.log(`  Funding Max/Slot:    ${configArgs.fundingMaxBpsPerSlot} bps`);
        console.log(`  Thresh Floor:        ${configArgs.threshFloor}`);
        console.log(`  Thresh Risk:         ${configArgs.threshRiskBps} bps`);
        console.log(`  Thresh Interval:     ${configArgs.threshUpdateIntervalSlots} slots`);
        console.log(`  Thresh Step:         ${configArgs.threshStepBps} bps`);
        console.log(`  Thresh Alpha:        ${configArgs.threshAlphaBps} bps`);
        console.log(`  Thresh Min:          ${configArgs.threshMin}`);
        console.log(`  Thresh Max:          ${configArgs.threshMax}`);
        console.log(`  Thresh Min Step:     ${configArgs.threshMinStep}`);
      }

      console.log(formatResult(result, flags.json ?? false));
    });
}
