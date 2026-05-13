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
import { validateU16 } from "../validation.js";

export function registerUpdateConfig(program: Command): void {
  program
    .command("update-config")
    .description("Update funding parameters and TVL cap (admin only). Omitted flags keep their current on-chain values.")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .option("--funding-horizon-slots <n>", "Funding horizon in slots (unchanged if omitted)")
    .option("--funding-k-bps <n>", "Funding multiplier in bps (unchanged if omitted)")
    .option("--funding-max-premium-bps <n>", "Max funding premium in bps (unchanged if omitted)")
    .option("--funding-max-e9-per-slot <n>", "Max funding rate per slot, e9 units (unchanged if omitted)")
    .option("--tvl-insurance-cap-mult <n>", "Deposit cap: c_tot ≤ k × insurance (0=disabled, 20=20× coverage; unchanged if omitted)")
    .option("--oracle <pubkey>", "Oracle account (required for non-Hyperp markets; Hyperp markets accept any pubkey)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Always fetch current on-chain config; we use it both as the
      // baseline for omitted parameters and to detect Hyperp vs non-Hyperp
      // for oracle-account selection.
      const buf = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const onChain = parseConfig(buf);

      const configArgs = {
        fundingHorizonSlots: opts.fundingHorizonSlots !== undefined
          ? BigInt(opts.fundingHorizonSlots) : onChain.fundingHorizonSlots,
        fundingKBps: opts.fundingKBps !== undefined
          ? BigInt(opts.fundingKBps) : onChain.fundingKBps,
        fundingMaxPremiumBps: opts.fundingMaxPremiumBps !== undefined
          ? BigInt(opts.fundingMaxPremiumBps) : onChain.fundingMaxPremiumBps,
        fundingMaxE9PerSlot: opts.fundingMaxE9PerSlot !== undefined
          ? BigInt(opts.fundingMaxE9PerSlot) : onChain.fundingMaxE9PerSlot,
        tvlInsuranceCapMult: opts.tvlInsuranceCapMult !== undefined
          ? validateU16(opts.tvlInsuranceCapMult, "--tvl-insurance-cap-mult")
          : onChain.tvlInsuranceCapMult,
      };

      const ixData = encodeUpdateConfig(configArgs);

      // Oracle slot: explicit --oracle wins; otherwise Hyperp markets use
      // the slab itself (wrapper accepts any pubkey when feed_id is zero),
      // and non-Hyperp markets force the operator to be explicit because
      // the on-chain config stores the Pyth feed-id hash, not the
      // PriceUpdateV2 account pubkey.
      let oracle: PublicKey;
      if (opts.oracle) {
        oracle = validatePublicKey(opts.oracle, "--oracle");
      } else {
        const ZERO = new PublicKey(new Uint8Array(32));
        const isHyperp = onChain.indexFeedId.equals(ZERO);
        if (isHyperp) {
          oracle = slabPk;
        } else {
          throw new Error(
            "Non-Hyperp market detected (indexFeedId ≠ 0). Pass --oracle <pubkey> with the Pyth/Chainlink account used at InitMarket."
          );
        }
      }

      const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
        ctx.payer.publicKey,
        slabPk,
        WELL_KNOWN.clock,
        oracle,
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
        rpcUrl: config.rpcUrl,
        allowMainnet: flags.yesMainnet ?? false,
      });

      if (!flags.json) {
        const tag = (k: keyof typeof configArgs) =>
          opts[k] !== undefined ? "*" : " ";
        console.log("Config submitted (* = changed by this call):");
        console.log(`  ${tag("fundingHorizonSlots")} Funding Horizon:     ${configArgs.fundingHorizonSlots} slots`);
        console.log(`  ${tag("fundingKBps")} Funding K:           ${configArgs.fundingKBps} bps`);
        console.log(`  ${tag("fundingMaxPremiumBps")} Funding Max Premium: ${configArgs.fundingMaxPremiumBps} bps`);
        console.log(`  ${tag("fundingMaxE9PerSlot")} Funding Max/Slot:    ${configArgs.fundingMaxE9PerSlot} e9`);
        console.log(`  ${tag("tvlInsuranceCapMult")} TVL Insurance Cap:   ${configArgs.tvlInsuranceCapMult}× insurance`);
      }

      console.log(formatResult(result, flags.json ?? false));
    });
}
