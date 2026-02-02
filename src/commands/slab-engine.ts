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
              lastCrankSlot: engine.lastCrankSlot.toString(),
              maxCrankStalenessSlots: engine.maxCrankStalenessSlots.toString(),
              totalOpenInterest: engine.totalOpenInterest.toString(),
              cTot: engine.cTot.toString(),
              pnlPosTot: engine.pnlPosTot.toString(),
              lifetimeLiquidations: engine.lifetimeLiquidations.toString(),
              lifetimeForceCloses: engine.lifetimeForceCloses.toString(),
              netLpPos: engine.netLpPos.toString(),
              lpSumAbs: engine.lpSumAbs.toString(),
              lpMaxAbs: engine.lpMaxAbs.toString(),
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
        console.log("--- Aggregates ---");
        console.log(`Total Open Interest:     ${engine.totalOpenInterest}`);
        console.log(`C_tot (total capital):   ${engine.cTot}`);
        console.log(`PnL_pos_tot (pos PnL):   ${engine.pnlPosTot}`);
        console.log("");
        console.log("--- LP ---");
        console.log(`Net LP Position:         ${engine.netLpPos}`);
        console.log(`LP Sum Abs:              ${engine.lpSumAbs}`);
        console.log(`LP Max Abs:              ${engine.lpMaxAbs}`);
        console.log("");
        console.log("--- Keeper ---");
        console.log(`Last Crank Slot:         ${engine.lastCrankSlot}`);
        console.log(`Max Crank Staleness:     ${engine.maxCrankStalenessSlots}`);
        console.log(`Lifetime Liquidations:   ${engine.lifetimeLiquidations}`);
        console.log(`Lifetime Force Closes:   ${engine.lifetimeForceCloses}`);
        console.log("");
        console.log("--- Accounts ---");
        console.log(`Num Used Accounts:       ${engine.numUsedAccounts}`);
        console.log(`Next Account ID:         ${engine.nextAccountId}`);
      }
    });
}
