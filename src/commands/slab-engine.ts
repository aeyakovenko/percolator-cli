import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseEngine } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

export function registerSlabEngine(program: Command): void {
  program
    .command("slab:engine")
    .description("Display RiskEngine state (vault, insurance, funding, flags)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);
      const engine = parseEngine(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              vault: engine.vault.toString(),
              insuranceFund: {
                balance: engine.insuranceFund.balance.toString(),
                feeRevenue: engine.insuranceFund.feeRevenue.toString(),
              },
              currentSlot: engine.currentSlot.toString(),
              fundingIndexQpbE6: engine.fundingIndexQpbE6.toString(),
              lastFundingSlot: engine.lastFundingSlot.toString(),
              lossAccum: engine.lossAccum.toString(),
              riskReductionOnly: engine.riskReductionOnly,
              riskReductionModeWithdrawn: engine.riskReductionModeWithdrawn.toString(),
              warmupPaused: engine.warmupPaused,
              warmupPauseSlot: engine.warmupPauseSlot.toString(),
              lastCrankSlot: engine.lastCrankSlot.toString(),
              maxCrankStalenessSlots: engine.maxCrankStalenessSlots.toString(),
              totalOpenInterest: engine.totalOpenInterest.toString(),
              warmedPosTotal: engine.warmedPosTotal.toString(),
              warmedNegTotal: engine.warmedNegTotal.toString(),
              warmupInsuranceReserved: engine.warmupInsuranceReserved.toString(),
              numUsedAccounts: engine.numUsedAccounts,
              nextAccountId: engine.nextAccountId.toString(),
            },
            null,
            2
          )
        );
      } else {
        console.log("--- Vault & Insurance ---");
        console.log(`Vault Balance:           ${engine.vault}`);
        console.log(`Insurance Balance:       ${engine.insuranceFund.balance}`);
        console.log(`Insurance Fee Revenue:   ${engine.insuranceFund.feeRevenue}`);
        console.log("");
        console.log("--- Funding ---");
        console.log(`Funding Index (qpb*1e6): ${engine.fundingIndexQpbE6}`);
        console.log(`Last Funding Slot:       ${engine.lastFundingSlot}`);
        console.log(`Current Slot:            ${engine.currentSlot}`);
        console.log("");
        console.log("--- Risk State ---");
        console.log(`Risk Reduction Only:     ${engine.riskReductionOnly}`);
        console.log(`RR Mode Withdrawn:       ${engine.riskReductionModeWithdrawn}`);
        console.log(`Loss Accumulator:        ${engine.lossAccum}`);
        console.log(`Total Open Interest:     ${engine.totalOpenInterest}`);
        console.log("");
        console.log("--- Warmup ---");
        console.log(`Warmup Paused:           ${engine.warmupPaused}`);
        console.log(`Warmup Pause Slot:       ${engine.warmupPauseSlot}`);
        console.log(`Warmed Pos Total:        ${engine.warmedPosTotal}`);
        console.log(`Warmed Neg Total:        ${engine.warmedNegTotal}`);
        console.log(`Warmup Insurance Rsv:    ${engine.warmupInsuranceReserved}`);
        console.log("");
        console.log("--- Keeper ---");
        console.log(`Last Crank Slot:         ${engine.lastCrankSlot}`);
        console.log(`Max Crank Staleness:     ${engine.maxCrankStalenessSlots}`);
        console.log("");
        console.log("--- Accounts ---");
        console.log(`Num Used Accounts:       ${engine.numUsedAccounts}`);
        console.log(`Next Account ID:         ${engine.nextAccountId}`);
      }
    });
}
