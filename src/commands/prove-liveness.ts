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
const SLOT_DURATION_SECS = 0.4;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function registerProveLiveness(program: Command): void {
  program
    .command("prove-liveness")
    .description(
      "Produce a liveness proof: snapshot demonstrating autonomous market operation"
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

      const currentSlot = await ctx.connection.getSlot();
      const currentSlotBigInt = BigInt(currentSlot);

      const adminBurned = header.admin.equals(BURNED_ADMIN);
      const balance = engine.insuranceFund.balance;
      const feeRevenue = engine.insuranceFund.feeRevenue;
      const totalOI = engine.totalOpenInterest;
      const vault = engine.vault;
      const cTot = engine.cTot;
      const pnlPosTot = engine.pnlPosTot;

      // Keeper freshness
      const slotsSinceLastCrank = currentSlotBigInt > engine.lastCrankSlot
        ? currentSlotBigInt - engine.lastCrankSlot
        : 0n;
      const crankFresh = slotsSinceLastCrank <= engine.maxCrankStalenessSlots;

      // Sweep freshness
      const slotsSinceLastSweep = currentSlotBigInt > engine.lastSweepStartSlot
        ? currentSlotBigInt - engine.lastSweepStartSlot
        : 0n;

      // Insurance growing check: feeRevenue > 0 means fees are flowing
      const insuranceGrowing = feeRevenue > 0n;

      // No haircuts
      const noHaircuts = cTot >= pnlPosTot || pnlPosTot === 0n;

      // No losses absorbed
      const noLossesAbsorbed = balance >= feeRevenue;

      // Market has activity
      const hasActivity = engine.numUsedAccounts > 0;

      // Liveness assertions
      const assertions: { claim: string; evidence: string; holds: boolean }[] = [
        {
          claim: "Market runs without intervention",
          evidence: adminBurned
            ? `Admin burned to ${BURNED_ADMIN.toBase58()}`
            : `Admin is ${header.admin.toBase58()} (NOT burned)`,
          holds: adminBurned,
        },
        {
          claim: "Keeper is active",
          evidence: crankFresh
            ? `Last crank ${formatDuration(Number(slotsSinceLastCrank) * SLOT_DURATION_SECS)} ago (slot ${engine.lastCrankSlot})`
            : `Last crank ${formatDuration(Number(slotsSinceLastCrank) * SLOT_DURATION_SECS)} ago — STALE`,
          holds: crankFresh,
        },
        {
          claim: "Insurance grows if there is volume",
          evidence: insuranceGrowing
            ? `Fee revenue: ${feeRevenue}, Insurance balance: ${balance}`
            : "No fee revenue yet (zero volume)",
          holds: insuranceGrowing,
        },
        {
          claim: "Nothing breaks if nobody touches it",
          evidence: noHaircuts
            ? `No haircuts active (c_tot=${cTot} >= pnl_pos_tot=${pnlPosTot})`
            : `WARNING: Haircuts active (c_tot=${cTot} < pnl_pos_tot=${pnlPosTot})`,
          holds: noHaircuts,
        },
        {
          claim: "Time alone improves market quality",
          evidence: noLossesAbsorbed
            ? `Insurance fund intact: balance (${balance}) >= fee_revenue (${feeRevenue})`
            : `Insurance absorbed losses: balance (${balance}) < fee_revenue (${feeRevenue})`,
          holds: noLossesAbsorbed,
        },
      ];

      const allHold = assertions.every((a) => a.holds);
      const timestamp = new Date().toISOString();

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              proofType: "liveness",
              timestamp,
              slab: slabPk.toBase58(),
              currentSlot,
              verdict: allHold ? "ALIVE" : "DEGRADED",
              assertions: assertions.map((a) => ({
                claim: a.claim,
                evidence: a.evidence,
                holds: a.holds,
              })),
              state: {
                admin: header.admin.toBase58(),
                adminBurned,
                vault: vault.toString(),
                insuranceBalance: balance.toString(),
                insuranceFeeRevenue: feeRevenue.toString(),
                totalOpenInterest: totalOI.toString(),
                cTot: cTot.toString(),
                pnlPosTot: pnlPosTot.toString(),
                numUsedAccounts: engine.numUsedAccounts,
                nextAccountId: engine.nextAccountId.toString(),
                lastCrankSlot: engine.lastCrankSlot.toString(),
                lastSweepStartSlot: engine.lastSweepStartSlot.toString(),
                lastSweepCompleteSlot: engine.lastSweepCompleteSlot.toString(),
                lifetimeLiquidations: engine.lifetimeLiquidations.toString(),
                lifetimeForceCloses: engine.lifetimeForceCloses.toString(),
                tradingFeeBps: params.tradingFeeBps.toString(),
                maintenanceMarginBps: params.maintenanceMarginBps.toString(),
                initialMarginBps: params.initialMarginBps.toString(),
              },
            },
            null,
            2
          )
        );
      } else {
        console.log("=== Liveness Proof ===");
        console.log(`Slab:      ${slabPk.toBase58()}`);
        console.log(`Timestamp: ${timestamp}`);
        console.log(`Slot:      ${currentSlot}`);
        console.log("");

        for (const a of assertions) {
          const icon = a.holds ? "HOLDS" : "FAILS";
          console.log(`[${icon}] ${a.claim}`);
          console.log(`        ${a.evidence}`);
        }

        console.log("");
        console.log("--- Market Snapshot ---");
        console.log(`Vault:               ${vault}`);
        console.log(`Insurance:           ${balance}`);
        console.log(`Fee Revenue:         ${feeRevenue}`);
        console.log(`Open Interest:       ${totalOI}`);
        console.log(`Active Accounts:     ${engine.numUsedAccounts}`);
        console.log(`Lifetime Liq:        ${engine.lifetimeLiquidations}`);
        console.log(`Lifetime Force Close:${engine.lifetimeForceCloses}`);

        console.log("");
        if (allHold) {
          console.log("VERDICT: ALIVE");
          console.log("");
          console.log(
            '"This market has no owner, no knobs, and no promises.'
          );
          console.log(
            'Its only reputation is how long it has survived and how honestly it prices risk."'
          );
        } else {
          console.log("VERDICT: DEGRADED");
          console.log("");
          console.log(
            "One or more liveness assertions failed. Review the FAILS above."
          );
          if (!adminBurned) {
            console.log(
              "The market is not yet adminless. Run `burn-admin` to make it immutable."
            );
          }
        }
      }
    });
}
