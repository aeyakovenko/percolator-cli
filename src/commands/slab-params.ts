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
      const data = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const params = parseParams(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
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
            null,
            2
          )
        );
      } else {
        console.log("--- Margins ---");
        console.log(`Initial Margin:          ${params.initialMarginBps} bps`);
        console.log(`Maintenance Margin:      ${params.maintenanceMarginBps} bps`);
        console.log(`Min Nonzero MM Req:      ${params.minNonzeroMmReq}`);
        console.log(`Min Nonzero IM Req:      ${params.minNonzeroImReq}`);
        console.log("");
        console.log("--- Fees ---");
        console.log(`Trading Fee:             ${params.tradingFeeBps} bps`);
        console.log("");
        console.log("--- Liquidation ---");
        console.log(`Liquidation Fee:         ${params.liquidationFeeBps} bps`);
        console.log(`Liquidation Fee Cap:     ${params.liquidationFeeCap}`);
        console.log(`Min Liquidation Abs:     ${params.minLiquidationAbs}`);
        console.log("");
        console.log("--- Capacity ---");
        console.log(`Max Accounts:            ${params.maxAccounts}`);
        console.log(`Max Active Per Side:     ${params.maxActivePositionsPerSide}`);
        console.log("");
        console.log("--- Warmup / Resolve ---");
        console.log(`h_min:                   ${params.hMin} slots`);
        console.log(`h_max:                   ${params.hMax} slots`);
        console.log(`Resolve Price Deviation: ${params.resolvePriceDeviationBps} bps`);
        console.log("");
        console.log("--- Funding Envelope ---");
        console.log(`Max Accrual dt:          ${params.maxAccrualDtSlots} slots`);
        console.log(`Max |Rate| e9/slot:      ${params.maxAbsFundingE9PerSlot}`);
        console.log(`Min Funding Lifetime:    ${params.minFundingLifetimeSlots} slots`);
        console.log("");
        console.log("--- Price-Move Envelope (v12.21+) ---");
        console.log(`Max Price Move:          ${params.maxPriceMoveBpsPerSlot} bps/slot`);
      }
    });
}
