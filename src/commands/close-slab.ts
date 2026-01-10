import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeCloseSlab } from "../abi/instructions.js";
import {
  ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

export function registerCloseSlab(program: Command): void {
  program
    .command("close-slab")
    .description("Close a market slab and recover SOL to admin")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Build instruction data
      const ixData = encodeCloseSlab();

      // Build account metas (order matches ACCOUNTS_CLOSE_SLAB)
      const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
        ctx.payer.publicKey, // admin
        slabPk, // slab
      ]);

      const ix = buildIx({
        programId: ctx.programId,
        keys,
        data: ixData,
      });

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers: [ctx.payer],
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
