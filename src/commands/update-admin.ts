import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeUpdateAdmin } from "../abi/instructions.js";
import {
  ACCOUNTS_UPDATE_ADMIN,
  buildAccountMetas,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerUpdateAdmin(program: Command): void {
  program
    .command("update-admin")
    .description("Transfer admin rights to new address (admin only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--new-admin <pubkey>", "New admin public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const newAdmin = new PublicKey(opts.newAdmin);

      // Build instruction data
      const ixData = encodeUpdateAdmin({ newAdmin });

      // Build account metas (order matches ACCOUNTS_UPDATE_ADMIN)
      const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [
        ctx.payer.publicKey, // admin (current)
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
