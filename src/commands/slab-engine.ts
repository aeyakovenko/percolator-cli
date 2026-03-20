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
              fundingRateBpsPerSlotLast: engine.fundingRateBpsPerSlotLast.toString(),
              lastCrankSlot: engine.lastCrankSlot.toString(),
              maxCrankStalenessSlots: engine.maxCrankStalenessSlots.toString(),
              cTot: engine.cTot.toString(),
              pnlPosTot: engine.pnlPosTot.toString(),
              pnlMaturedPosTot: engine.pnlMaturedPosTot.toString(),
              lifetimeLiquidations: engine.lifetimeLiquidations.toString(),
              adlMultLong: engine.adlMultLong.toString(),
              adlMultShort: engine.adlMultShort.toString(),
              adlCoeffLong: engine.adlCoeffLong.toString(),
              adlCoeffShort: engine.adlCoeffShort.toString(),
              adlEpochLong: engine.adlEpochLong.toString(),
              adlEpochShort: engine.adlEpochShort.toString(),
              oiEffLongQ: engine.oiEffLongQ.toString(),
              oiEffShortQ: engine.oiEffShortQ.toString(),
              sideModeLong: engine.sideModeLong,
              sideModeShort: engine.sideModeShort,
              storedPosCountLong: engine.storedPosCountLong.toString(),
              storedPosCountShort: engine.storedPosCountShort.toString(),
              materializedAccountCount: engine.materializedAccountCount.toString(),
              lastOraclePrice: engine.lastOraclePrice.toString(),
              lastMarketSlot: engine.lastMarketSlot.toString(),
              fundingPriceSampleLast: engine.fundingPriceSampleLast.toString(),
              insuranceFloor: engine.insuranceFloor.toString(),
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
        console.log(`Insurance Floor:         ${engine.insuranceFloor}`);
        console.log("");
        console.log("--- Funding ---");
        console.log(`Funding Rate (bps/slot): ${engine.fundingRateBpsPerSlotLast}`);
        console.log(`Funding Price Sample:    ${engine.fundingPriceSampleLast}`);
        console.log(`Current Slot:            ${engine.currentSlot}`);
        console.log("");
        console.log("--- Aggregates ---");
        console.log(`C_tot (total capital):   ${engine.cTot}`);
        console.log(`PnL_pos_tot (pos PnL):   ${engine.pnlPosTot}`);
        console.log(`PnL_matured_pos_tot:     ${engine.pnlMaturedPosTot}`);
        console.log(`OI Eff Long Q:           ${engine.oiEffLongQ}`);
        console.log(`OI Eff Short Q:          ${engine.oiEffShortQ}`);
        console.log("");
        console.log("--- ADL State ---");
        console.log(`ADL Mult Long:           ${engine.adlMultLong}`);
        console.log(`ADL Mult Short:          ${engine.adlMultShort}`);
        console.log(`ADL Coeff Long:          ${engine.adlCoeffLong}`);
        console.log(`ADL Coeff Short:         ${engine.adlCoeffShort}`);
        console.log(`ADL Epoch Long:          ${engine.adlEpochLong}`);
        console.log(`ADL Epoch Short:         ${engine.adlEpochShort}`);
        console.log("");
        console.log("--- Side Modes ---");
        console.log(`Side Mode Long:          ${engine.sideModeLong}`);
        console.log(`Side Mode Short:         ${engine.sideModeShort}`);
        console.log(`Stored Pos Count Long:   ${engine.storedPosCountLong}`);
        console.log(`Stored Pos Count Short:  ${engine.storedPosCountShort}`);
        console.log("");
        console.log("--- Keeper ---");
        console.log(`Last Crank Slot:         ${engine.lastCrankSlot}`);
        console.log(`Max Crank Staleness:     ${engine.maxCrankStalenessSlots}`);
        console.log(`Lifetime Liquidations:   ${engine.lifetimeLiquidations}`);
        console.log(`Last Oracle Price:       ${engine.lastOraclePrice}`);
        console.log(`Last Market Slot:        ${engine.lastMarketSlot}`);
        console.log("");
        console.log("--- Accounts ---");
        console.log(`Num Used Accounts:       ${engine.numUsedAccounts}`);
        console.log(`Materialized Accounts:   ${engine.materializedAccountCount}`);
        console.log(`Next Account ID:         ${engine.nextAccountId}`);
      }
    });
}
