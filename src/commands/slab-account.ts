import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseAccount, isAccountUsed, AccountKind } from "../solana/slab.js";
import { validatePublicKey, validateIndex } from "../validation.js";

export function registerSlabAccount(program: Command): void {
  program
    .command("slab:account")
    .description("Display a single account by index")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--idx <number>", "Account index (0-4095)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const idx = validateIndex(opts.idx, "--idx");
      const data = await fetchSlab(ctx.connection, slabPk);

      if (!isAccountUsed(data, idx)) {
        if (flags.json) {
          console.log(JSON.stringify({ error: "Account not in use", idx }, null, 2));
        } else {
          console.log(`Account ${idx} is not in use`);
        }
        process.exitCode = 1;
        return;
      }

      const account = parseAccount(data, idx);
      const kindStr = account.kind === AccountKind.LP ? "LP" : "User";

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              idx,
              kind: kindStr,
              owner: account.owner.toBase58(),
              capital: account.capital.toString(),
              pnl: account.pnl.toString(),
              reservedPnl: account.reservedPnl.toString(),
              positionBasisQ: account.positionBasisQ.toString(),
              adlABasis: account.adlABasis.toString(),
              adlKSnap: account.adlKSnap.toString(),
              fSnap: account.fSnap.toString(),
              adlEpochSnap: account.adlEpochSnap.toString(),
              feeCredits: account.feeCredits.toString(),
              lastFeeSlot: account.lastFeeSlot.toString(),
              schedPresent: account.schedPresent,
              schedRemainingQ: account.schedRemainingQ.toString(),
              schedAnchorQ: account.schedAnchorQ.toString(),
              schedStartSlot: account.schedStartSlot.toString(),
              schedHorizon: account.schedHorizon.toString(),
              schedReleaseQ: account.schedReleaseQ.toString(),
              pendingPresent: account.pendingPresent,
              pendingRemainingQ: account.pendingRemainingQ.toString(),
              pendingHorizon: account.pendingHorizon.toString(),
              pendingCreatedSlot: account.pendingCreatedSlot.toString(),
              matcherProgram: account.matcherProgram.toBase58(),
              matcherContext: account.matcherContext.toBase58(),
            },
            null,
            2
          )
        );
      } else {
        console.log(`--- Account ${idx} (${kindStr}) ---`);
        console.log(`Owner:                   ${account.owner.toBase58()}`);
        console.log("");
        console.log("--- Capital & PnL ---");
        console.log(`Capital:                 ${account.capital}`);
        console.log(`PnL:                     ${account.pnl}`);
        console.log(`Reserved PnL:            ${account.reservedPnl}`);
        console.log(`Fee Credits:             ${account.feeCredits}`);
        console.log(`Last Fee Slot:           ${account.lastFeeSlot}`);
        console.log("");
        console.log("--- Position ---");
        console.log(`Position Basis Q:        ${account.positionBasisQ}`);
        console.log(`ADL A Basis:             ${account.adlABasis}`);
        console.log(`ADL K Snap:              ${account.adlKSnap}`);
        console.log(`F Snap:                  ${account.fSnap}`);
        console.log(`ADL Epoch Snap:          ${account.adlEpochSnap}`);
        console.log("");
        console.log("--- Warmup Buckets (two-bucket) ---");
        console.log(`Sched present:           ${account.schedPresent}`);
        console.log(`Sched remaining_q:       ${account.schedRemainingQ}`);
        console.log(`Sched anchor_q:          ${account.schedAnchorQ}`);
        console.log(`Sched start/horizon:     ${account.schedStartSlot} / ${account.schedHorizon}`);
        console.log(`Sched release_q:         ${account.schedReleaseQ}`);
        console.log(`Pending present:         ${account.pendingPresent}`);
        console.log(`Pending remaining_q:     ${account.pendingRemainingQ}`);
        console.log(`Pending horizon/created: ${account.pendingHorizon} / ${account.pendingCreatedSlot}`);
        if (account.kind === AccountKind.LP) {
          console.log("");
          console.log("--- Matcher (LP only) ---");
          console.log(`Matcher Program:         ${account.matcherProgram.toBase58()}`);
          console.log(`Matcher Context:         ${account.matcherContext.toBase58()}`);
        }
      }
    });
}
