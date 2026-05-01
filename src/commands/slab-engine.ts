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
      const data = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const engine = parseEngine(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              vault: engine.vault.toString(),
              insuranceFund: { balance: engine.insuranceFund.balance.toString() },
              currentSlot: engine.currentSlot.toString(),
              marketMode: engine.marketMode,
              resolvedPrice: engine.resolvedPrice.toString(),
              resolvedSlot: engine.resolvedSlot.toString(),
              cTot: engine.cTot.toString(),
              pnlPosTot: engine.pnlPosTot.toString(),
              pnlMaturedPosTot: engine.pnlMaturedPosTot.toString(),
              rrCursorPosition: engine.rrCursorPosition.toString(),
              sweepGeneration: engine.sweepGeneration.toString(),
              priceMoveConsumedBpsThisGeneration: engine.priceMoveConsumedBpsThisGeneration.toString(),
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
              negPnlAccountCount: engine.negPnlAccountCount.toString(),
              lastOraclePrice: engine.lastOraclePrice.toString(),
              fundPxLast: engine.fundPxLast.toString(),
              lastMarketSlot: engine.lastMarketSlot.toString(),
              fLongNum: engine.fLongNum.toString(),
              fShortNum: engine.fShortNum.toString(),
              fEpochStartLongNum: engine.fEpochStartLongNum.toString(),
              fEpochStartShortNum: engine.fEpochStartShortNum.toString(),
              numUsedAccounts: engine.numUsedAccounts,
              freeHead: engine.freeHead,
            },
            null,
            2
          )
        );
      } else {
        console.log("--- Vault & Insurance ---");
        console.log(`Vault Balance:           ${engine.vault}`);
        console.log(`Insurance Balance:       ${engine.insuranceFund.balance}`);
        console.log("");
        console.log("--- Market ---");
        console.log(`Market Mode:             ${engine.marketMode === 0 ? "Live" : "Resolved"}`);
        console.log(`Resolved Price:          ${engine.resolvedPrice}`);
        console.log(`Resolved Slot:           ${engine.resolvedSlot}`);
        console.log(`Current Slot:            ${engine.currentSlot}`);
        console.log("");
        console.log("--- Aggregates ---");
        console.log(`C_tot (total capital):   ${engine.cTot}`);
        console.log(`PnL_pos_tot:             ${engine.pnlPosTot}`);
        console.log(`PnL_matured_pos_tot:     ${engine.pnlMaturedPosTot}`);
        console.log(`OI Eff Long Q:           ${engine.oiEffLongQ}`);
        console.log(`OI Eff Short Q:          ${engine.oiEffShortQ}`);
        console.log("");
        console.log("--- ADL State ---");
        console.log(`ADL Mult Long:           ${engine.adlMultLong}`);
        console.log(`ADL Mult Short:          ${engine.adlMultShort}`);
        console.log(`ADL Coeff Long:          ${engine.adlCoeffLong}`);
        console.log(`ADL Coeff Short:         ${engine.adlCoeffShort}`);
        console.log(`ADL Epoch Long/Short:    ${engine.adlEpochLong} / ${engine.adlEpochShort}`);
        console.log("");
        console.log("--- Side Modes ---");
        console.log(`Side Mode Long/Short:    ${engine.sideModeLong} / ${engine.sideModeShort}`);
        console.log(`Stored Pos Count L/S:    ${engine.storedPosCountLong} / ${engine.storedPosCountShort}`);
        console.log("");
        console.log("--- Funding (F) ---");
        console.log(`F Long Num:              ${engine.fLongNum}`);
        console.log(`F Short Num:             ${engine.fShortNum}`);
        console.log(`F Epoch Start Long:      ${engine.fEpochStartLongNum}`);
        console.log(`F Epoch Start Short:     ${engine.fEpochStartShortNum}`);
        console.log(`Fund Px Last:            ${engine.fundPxLast}`);
        console.log("");
        console.log("--- Keeper ---");
        console.log(`Last Oracle Price:       ${engine.lastOraclePrice}`);
        console.log(`Last Market Slot:        ${engine.lastMarketSlot}`);
        console.log(`RR Cursor Position:      ${engine.rrCursorPosition}`);
        console.log(`Sweep Generation:        ${engine.sweepGeneration}`);
        console.log(`PriceMoveConsumed bps:   ${engine.priceMoveConsumedBpsThisGeneration}`);
        console.log("");
        console.log("--- Accounts ---");
        console.log(`Num Used:                ${engine.numUsedAccounts}`);
        console.log(`Free Head:               ${engine.freeHead}`);
        console.log(`Materialized:            ${engine.materializedAccountCount}`);
        console.log(`Neg-PnL Accounts:        ${engine.negPnlAccountCount}`);
      }
    });
}
