import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeUpdateConfig } from "../abi/instructions.js";
import {
  ACCOUNTS_UPDATE_CONFIG,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { PublicKey } from "@solana/web3.js";

// Default values (from percolator-prog constants)
const DEFAULTS = {
  fundingHorizonSlots: 500n,
  fundingKBps: 100n,
  fundingInvScaleNotionalE6: 1_000_000_000_000n, // $1M in e6
  fundingMaxPremiumBps: 500n,
  fundingMaxE9PerSlot: 5n,
  threshFloor: 0n,
  threshRiskBps: 50n,
  threshUpdateIntervalSlots: 10n,
  threshStepBps: 500n,
  threshAlphaBps: 1000n,
  threshMin: 0n,
  threshMax: 10_000_000_000_000_000_000n,
  threshMinStep: 1n,
};

export function registerUpdateConfig(program: Command): void {
  program
    .command("update-config")
    .description("Update funding and threshold parameters (admin only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    // Funding parameters
    .option("--funding-horizon-slots <n>", "Funding horizon in slots (default: 500)")
    .option("--funding-k-bps <n>", "Funding multiplier in bps (default: 100 = 1.00x)")
    .option("--funding-scale <n>", "Funding inventory scale notional e6 (default: 1000000000000 = $1M)")
    .option("--funding-max-premium-bps <n>", "Max funding premium in bps (default: 500)")
    .option("--funding-max-bps-per-slot <n>", "Max funding rate per slot in bps (default: 5)")
    // Threshold parameters
    .option("--thresh-floor <n>", "Threshold floor (default: 0)")
    .option("--thresh-risk-bps <n>", "Threshold risk coefficient in bps (default: 50)")
    .option("--thresh-update-interval <n>", "Threshold update interval in slots (default: 10)")
    .option("--thresh-step-bps <n>", "Max threshold step in bps (default: 500)")
    .option("--thresh-alpha-bps <n>", "Threshold EWMA alpha in bps (default: 1000)")
    .option("--thresh-min <n>", "Minimum threshold (default: 0)")
    .option("--thresh-max <n>", "Maximum threshold (default: 10000000000000000000)")
    .option("--thresh-min-step <n>", "Minimum threshold step (default: 1)")
    .option("--tvl-insurance-cap-mult <n>", "Deposit cap: c_tot ≤ k × insurance (0=disabled, 20=20× coverage)", "0")
    .option("--oracle <pubkey>", "Oracle account (required for non-Hyperp markets; Hyperp markets accept any pubkey, default: slab)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Build config with defaults, overridden by provided options
      const configArgs = {
        fundingHorizonSlots: opts.fundingHorizonSlots ? BigInt(opts.fundingHorizonSlots) : DEFAULTS.fundingHorizonSlots,
        fundingKBps: opts.fundingKBps ? BigInt(opts.fundingKBps) : DEFAULTS.fundingKBps,
        fundingInvScaleNotionalE6: opts.fundingScale ? BigInt(opts.fundingScale) : DEFAULTS.fundingInvScaleNotionalE6,
        fundingMaxPremiumBps: opts.fundingMaxPremiumBps ? BigInt(opts.fundingMaxPremiumBps) : DEFAULTS.fundingMaxPremiumBps,
        fundingMaxE9PerSlot: opts.fundingMaxE9PerSlot ? BigInt(opts.fundingMaxE9PerSlot) : DEFAULTS.fundingMaxE9PerSlot,
        threshFloor: opts.threshFloor ? BigInt(opts.threshFloor) : DEFAULTS.threshFloor,
        threshRiskBps: opts.threshRiskBps ? BigInt(opts.threshRiskBps) : DEFAULTS.threshRiskBps,
        threshUpdateIntervalSlots: opts.threshUpdateInterval ? BigInt(opts.threshUpdateInterval) : DEFAULTS.threshUpdateIntervalSlots,
        threshStepBps: opts.threshStepBps ? BigInt(opts.threshStepBps) : DEFAULTS.threshStepBps,
        threshAlphaBps: opts.threshAlphaBps ? BigInt(opts.threshAlphaBps) : DEFAULTS.threshAlphaBps,
        threshMin: opts.threshMin ? BigInt(opts.threshMin) : DEFAULTS.threshMin,
        threshMax: opts.threshMax ? BigInt(opts.threshMax) : DEFAULTS.threshMax,
        threshMinStep: opts.threshMinStep ? BigInt(opts.threshMinStep) : DEFAULTS.threshMinStep,
        tvlInsuranceCapMult: parseInt(opts.tvlInsuranceCapMult ?? "0", 10),
      };

      const ixData = encodeUpdateConfig(configArgs);

      // Pick the oracle key. Priority: explicit --oracle flag > on-chain
      // config.indexFeedId (cast to PublicKey for non-Hyperp) > slab itself
      // (Hyperp default — wrapper accepts any pubkey when feed is all-zero).
      // Passing slabPk for a non-Hyperp market is the v1 bug fixed here:
      // the wrapper's accrue path reads the oracle, fails IllegalOwner, and
      // the config update silently aborts.
      let oracle: PublicKey;
      if (opts.oracle) {
        oracle = validatePublicKey(opts.oracle, "--oracle");
      } else {
        const buf = await fetchSlab(ctx.connection, slabPk);
        const c = parseConfig(buf);
        const ZERO = new PublicKey(new Uint8Array(32));
        const isHyperp = c.indexFeedId.equals(ZERO);
        if (isHyperp) {
          oracle = slabPk;
        } else {
          // For non-Hyperp markets the oracle pubkey is what the deployer
          // passed at InitMarket as accounts[5]; we don't have that on the
          // slab as a Pubkey (only the Pyth feed_id is stored, which is
          // NOT the same as the PriceUpdateV2 account pubkey). Force the
          // operator to be explicit rather than guessing.
          throw new Error(
            "Non-Hyperp market detected (indexFeedId ≠ 0). Pass --oracle <pubkey> with the Pyth/Chainlink account used at InitMarket."
          );
        }
      }

      const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
        ctx.payer.publicKey, // admin
        slabPk,              // slab
        WELL_KNOWN.clock,    // clock
        oracle,              // Hyperp: slab; non-Hyperp: Pyth/Chainlink account
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
        console.log(`  Funding Max/Slot:    ${configArgs.fundingMaxE9PerSlot} bps`);
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
