import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import {
  fetchSlab,
  parseHeader,
  parseEngine,
  parseParams,
} from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

const BURNED_ADMIN = new PublicKey("11111111111111111111111111111111");

export function registerInsuranceHealth(program: Command): void {
  program
    .command("insurance:health")
    .description(
      "Assess insurance fund health: coverage ratio, open interest, loss absorption"
    )
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);

      const header = parseHeader(data);
      const engine = parseEngine(data);
      const params = parseParams(data);

      const balance = engine.insuranceFund.balance;
      const feeRevenue = engine.insuranceFund.feeRevenue;
      const totalOI = engine.totalOpenInterest;
      const vault = engine.vault;
      const cTot = engine.cTot;
      const pnlPosTot = engine.pnlPosTot;
      const lifetimeLiqs = engine.lifetimeLiquidations;
      const lifetimeForceCloses = engine.lifetimeForceCloses;
      const adminBurned = header.admin.equals(BURNED_ADMIN);

      // Coverage ratio: insurance / total open interest
      const coverageRatioPct =
        totalOI > 0n ? Number((balance * 10000n) / totalOI) / 100 : 0;

      // Insurance as fraction of total capital
      const insuranceToCapitalPct =
        cTot > 0n ? Number((balance * 10000n) / cTot) / 100 : 0;

      // Losses absorbed: fee revenue that was consumed by liquidation shortfalls
      const lossesAbsorbed = feeRevenue > balance ? feeRevenue - balance : 0n;

      // Loss ratio: absorbed losses / total fee revenue
      const lossRatioPct =
        feeRevenue > 0n
          ? Number((lossesAbsorbed * 10000n) / feeRevenue) / 100
          : 0;

      // Haircut risk indicator: if cTot < pnlPosTot, haircuts are active
      const haircutsActive = cTot < pnlPosTot;

      // Health grade (simple heuristic based on coverage)
      let grade: string;
      if (coverageRatioPct >= 10) grade = "STRONG";
      else if (coverageRatioPct >= 5) grade = "ADEQUATE";
      else if (coverageRatioPct >= 2) grade = "THIN";
      else if (coverageRatioPct >= 0.5) grade = "WEAK";
      else grade = "CRITICAL";

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              slab: slabPk.toBase58(),
              health: {
                grade,
                coverageRatioPct,
                insuranceToCapitalPct,
                lossRatioPct,
                haircutsActive,
              },
              insurance: {
                balance: balance.toString(),
                feeRevenue: feeRevenue.toString(),
                lossesAbsorbed: lossesAbsorbed.toString(),
              },
              market: {
                totalOpenInterest: totalOI.toString(),
                vault: vault.toString(),
                cTot: cTot.toString(),
                pnlPosTot: pnlPosTot.toString(),
                lifetimeLiquidations: lifetimeLiqs.toString(),
                lifetimeForceCloses: lifetimeForceCloses.toString(),
              },
              adminBurned,
            },
            null,
            2
          )
        );
      } else {
        console.log("=== Insurance Fund Health ===");
        console.log(`Slab: ${slabPk.toBase58()}`);
        console.log("");
        console.log(`Health Grade:            ${grade}`);
        console.log("");
        console.log("--- Coverage ---");
        console.log(
          `Insurance / Open Interest: ${coverageRatioPct.toFixed(2)}%`
        );
        console.log(
          `Insurance / Total Capital: ${insuranceToCapitalPct.toFixed(2)}%`
        );
        console.log(`Insurance Balance:       ${balance}`);
        console.log(`Total Open Interest:     ${totalOI}`);
        console.log(`Total Capital (c_tot):   ${cTot}`);
        console.log("");
        console.log("--- Loss Absorption ---");
        console.log(`Cumulative Fee Revenue:  ${feeRevenue}`);
        console.log(`Losses Absorbed:         ${lossesAbsorbed}`);
        console.log(`Loss Ratio:              ${lossRatioPct.toFixed(2)}%`);
        console.log(
          `Haircuts Active:         ${haircutsActive ? "YES (undercollateralized)" : "NO"}`
        );
        console.log("");
        console.log("--- Liquidation History ---");
        console.log(`Lifetime Liquidations:   ${lifetimeLiqs}`);
        console.log(`Lifetime Force Closes:   ${lifetimeForceCloses}`);
        console.log("");
        console.log("--- Status ---");
        console.log(
          `Admin Burned:            ${adminBurned ? "YES (non-withdrawable)" : "NO"}`
        );

        if (haircutsActive) {
          console.log("");
          console.log(
            "WARNING: Haircut ratio is active. Total capital < sum of positive PnL."
          );
          console.log(
            "Winning positions may receive less than their full PnL on withdrawal."
          );
        }
      }
    });
}
