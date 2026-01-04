import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseParams } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

export function registerSlabParams(program: Command): void {
  program
    .command("slab:params")
    .description("Display RiskParams (margins, fees, thresholds)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);
      const params = parseParams(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              warmupPeriodSlots: params.warmupPeriodSlots.toString(),
              maintenanceMarginBps: params.maintenanceMarginBps.toString(),
              initialMarginBps: params.initialMarginBps.toString(),
              tradingFeeBps: params.tradingFeeBps.toString(),
              maxAccounts: params.maxAccounts.toString(),
              newAccountFee: params.newAccountFee.toString(),
              riskReductionThreshold: params.riskReductionThreshold.toString(),
              maintenanceFeePerSlot: params.maintenanceFeePerSlot.toString(),
              maxCrankStalenessSlots: params.maxCrankStalenessSlots.toString(),
              liquidationFeeBps: params.liquidationFeeBps.toString(),
              liquidationFeeCap: params.liquidationFeeCap.toString(),
              liquidationBufferBps: params.liquidationBufferBps.toString(),
              minLiquidationAbs: params.minLiquidationAbs.toString(),
            },
            null,
            2
          )
        );
      } else {
        console.log("--- Margins ---");
        console.log(`Initial Margin:          ${params.initialMarginBps} bps`);
        console.log(`Maintenance Margin:      ${params.maintenanceMarginBps} bps`);
        console.log("");
        console.log("--- Fees ---");
        console.log(`Trading Fee:             ${params.tradingFeeBps} bps`);
        console.log(`New Account Fee:         ${params.newAccountFee}`);
        console.log(`Maintenance Fee/Slot:    ${params.maintenanceFeePerSlot}`);
        console.log("");
        console.log("--- Liquidation ---");
        console.log(`Liquidation Fee:         ${params.liquidationFeeBps} bps`);
        console.log(`Liquidation Fee Cap:     ${params.liquidationFeeCap}`);
        console.log(`Liquidation Buffer:      ${params.liquidationBufferBps} bps`);
        console.log(`Min Liquidation Abs:     ${params.minLiquidationAbs}`);
        console.log("");
        console.log("--- Thresholds ---");
        console.log(`Risk Reduction Thresh:   ${params.riskReductionThreshold}`);
        console.log(`Max Crank Staleness:     ${params.maxCrankStalenessSlots} slots`);
        console.log("");
        console.log("--- Capacity ---");
        console.log(`Max Accounts:            ${params.maxAccounts}`);
        console.log(`Warmup Period:           ${params.warmupPeriodSlots} slots`);
      }
    });
}
