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
              accountId: account.accountId.toString(),
              owner: account.owner.toBase58(),
              capital: account.capital.toString(),
              pnl: account.pnl.toString(),
              reservedPnl: account.reservedPnl.toString(),
              positionSize: account.positionSize.toString(),
              entryPrice: account.entryPrice.toString(),
              fundingIndex: account.fundingIndex.toString(),
              feeCredits: account.feeCredits.toString(),
              lastFeeSlot: account.lastFeeSlot.toString(),
              warmupStartedAtSlot: account.warmupStartedAtSlot.toString(),
              warmupSlopePerStep: account.warmupSlopePerStep.toString(),
              matcherProgram: account.matcherProgram.toBase58(),
              matcherContext: account.matcherContext.toBase58(),
            },
            null,
            2
          )
        );
      } else {
        console.log(`--- Account ${idx} (${kindStr}) ---`);
        console.log(`Account ID:              ${account.accountId}`);
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
        console.log(`Position Size:           ${account.positionSize}`);
        console.log(`Entry Price:             ${account.entryPrice}`);
        console.log(`Funding Index:           ${account.fundingIndex}`);
        console.log("");
        console.log("--- Warmup ---");
        console.log(`Warmup Started:          ${account.warmupStartedAtSlot}`);
        console.log(`Warmup Slope:            ${account.warmupSlopePerStep}`);
        if (account.kind === AccountKind.LP) {
          console.log("");
          console.log("--- Matcher (LP only) ---");
          console.log(`Matcher Program:         ${account.matcherProgram.toBase58()}`);
          console.log(`Matcher Context:         ${account.matcherContext.toBase58()}`);
        }
      }
    });
}
