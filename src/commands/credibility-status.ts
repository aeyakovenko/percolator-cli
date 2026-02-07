import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import {
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
} from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

const BURNED_ADMIN = new PublicKey("11111111111111111111111111111111");

/**
 * Approximate Solana slot duration in seconds.
 * ~400ms per slot on mainnet.
 */
const SLOT_DURATION_SECS = 0.4;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function registerCredibilityStatus(program: Command): void {
  program
    .command("credibility:status")
    .description(
      "Display credibility metrics: market age, solvency, keeper activity, immutability"
    )
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);

      const header = parseHeader(data);
      const mktConfig = parseConfig(data);
      const engine = parseEngine(data);
      const params = parseParams(data);

      const adminBurned = header.admin.equals(BURNED_ADMIN);

      // Get current slot from the cluster
      const currentSlot = await ctx.connection.getSlot();
      const currentSlotBigInt = BigInt(currentSlot);

      // Market age: slots since the last crank (approximation of activity)
      // For true age, we'd need the init slot, but we can use nonce and
      // lastSweepStartSlot as proxies for how long the market has been active
      const lastCrankSlot = engine.lastCrankSlot;
      const slotsSinceLastCrank =
        currentSlotBigInt > lastCrankSlot
          ? currentSlotBigInt - lastCrankSlot
          : 0n;

      // Keeper health: is the crank recent enough?
      const crankFresh =
        slotsSinceLastCrank <= engine.maxCrankStalenessSlots;

      // Successful keeper operations (approximated by account lifecycle)
      const lifetimeLiqs = engine.lifetimeLiquidations;
      const lifetimeForceCloses = engine.lifetimeForceCloses;
      const totalRiskEvents = lifetimeLiqs + lifetimeForceCloses;

      // Solvency indicators
      const balance = engine.insuranceFund.balance;
      const feeRevenue = engine.insuranceFund.feeRevenue;
      const totalOI = engine.totalOpenInterest;
      const cTot = engine.cTot;
      const pnlPosTot = engine.pnlPosTot;

      // Solvency: is balance >= feeRevenue? If yes, no losses absorbed
      const noLossesAbsorbed = balance >= feeRevenue;

      // Haircut status
      const haircutsActive = cTot > 0n && cTot < pnlPosTot;

      // Parameter changes: admin burned means zero changes possible
      // If admin is not burned, changes are theoretically possible
      const parameterChanges = adminBurned ? 0 : -1; // -1 = unknown/possible

      // Oracle authority status
      const oracleAuthorityZero = mktConfig.oracleAuthority.equals(
        new PublicKey("11111111111111111111111111111111")
      );
      const oracleAuthorityClean = oracleAuthorityZero || adminBurned;

      // Coverage ratio
      const coverageRatioPct =
        totalOI > 0n ? Number((balance * 10000n) / totalOI) / 100 : 0;

      // Approximate time since last crank
      const timeSinceLastCrank =
        Number(slotsSinceLastCrank) * SLOT_DURATION_SECS;

      // Credibility summary
      const signals: { signal: string; value: string; healthy: boolean }[] = [
        {
          signal: "Admin burned",
          value: adminBurned ? "Yes" : "No",
          healthy: adminBurned,
        },
        {
          signal: "Parameter changes post-burn",
          value: parameterChanges === 0 ? "0 (immutable)" : "Unknown (admin active)",
          healthy: parameterChanges === 0,
        },
        {
          signal: "Oracle authority",
          value: oracleAuthorityClean ? "Clean" : "Active (mutable)",
          healthy: oracleAuthorityClean,
        },
        {
          signal: "Keeper crank",
          value: crankFresh ? `Fresh (${formatDuration(timeSinceLastCrank)} ago)` : `Stale (${formatDuration(timeSinceLastCrank)} ago)`,
          healthy: crankFresh,
        },
        {
          signal: "Insurance solvency",
          value: noLossesAbsorbed ? "No losses absorbed" : "Losses absorbed from insurance",
          healthy: noLossesAbsorbed,
        },
        {
          signal: "Haircut status",
          value: haircutsActive ? "ACTIVE (undercollateralized)" : "Inactive",
          healthy: !haircutsActive,
        },
        {
          signal: "Coverage ratio",
          value: `${coverageRatioPct.toFixed(2)}% of OI`,
          healthy: coverageRatioPct >= 5,
        },
      ];

      const healthyCount = signals.filter((s) => s.healthy).length;

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              slab: slabPk.toBase58(),
              credibility: {
                adminBurned,
                parameterChangesPostBurn: parameterChanges,
                oracleAuthorityClean,
                keeperCrankFresh: crankFresh,
                slotsSinceLastCrank: slotsSinceLastCrank.toString(),
                noLossesAbsorbed,
                haircutsActive,
                coverageRatioPct,
                healthySignals: healthyCount,
                totalSignals: signals.length,
              },
              riskEvents: {
                lifetimeLiquidations: lifetimeLiqs.toString(),
                lifetimeForceCloses: lifetimeForceCloses.toString(),
                totalRiskEvents: totalRiskEvents.toString(),
              },
              insurance: {
                balance: balance.toString(),
                feeRevenue: feeRevenue.toString(),
              },
              market: {
                totalOpenInterest: totalOI.toString(),
                cTot: cTot.toString(),
                pnlPosTot: pnlPosTot.toString(),
                numUsedAccounts: engine.numUsedAccounts,
                nextAccountId: engine.nextAccountId.toString(),
              },
              currentSlot: currentSlot,
              lastCrankSlot: lastCrankSlot.toString(),
            },
            null,
            2
          )
        );
      } else {
        console.log("=== Credibility Status ===");
        console.log(`Slab: ${slabPk.toBase58()}`);
        console.log(`Current Slot: ${currentSlot}`);
        console.log("");

        console.log("--- Credibility Signals ---");
        for (const s of signals) {
          const icon = s.healthy ? "OK" : "!!";
          console.log(`[${icon}] ${s.signal.padEnd(30)} ${s.value}`);
        }
        console.log("");
        console.log(`Score: ${healthyCount}/${signals.length} healthy signals`);

        console.log("");
        console.log("--- Risk Event History ---");
        console.log(`Lifetime Liquidations:   ${lifetimeLiqs}`);
        console.log(`Lifetime Force Closes:   ${lifetimeForceCloses}`);
        console.log(`Total Risk Events:       ${totalRiskEvents}`);

        console.log("");
        console.log("--- Market Activity ---");
        console.log(`Active Accounts:         ${engine.numUsedAccounts}`);
        console.log(`Total Accounts Created:  ${engine.nextAccountId}`);
        console.log(`Total Open Interest:     ${totalOI}`);
        console.log(`Insurance Balance:       ${balance}`);
        console.log(`Insurance Fee Revenue:   ${feeRevenue}`);

        console.log("");
        console.log("--- Interpretation ---");
        if (adminBurned && noLossesAbsorbed && !haircutsActive && crankFresh) {
          console.log(
            "This market is adminless, solvent, and actively maintained."
          );
          console.log(
            "Credibility is accruing through time and behavior."
          );
        } else if (!adminBurned) {
          console.log(
            "Admin key is not burned. Credibility cannot be assessed until the market is immutable."
          );
        } else {
          console.log(
            "Market is adminless but some health signals indicate stress."
          );
          console.log(
            "Review the signals above for details."
          );
        }
      }
    });
}
