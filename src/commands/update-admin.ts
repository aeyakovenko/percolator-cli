import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeUpdateAuthority, AUTHORITY_KIND } from "../abi/instructions.js";
import {
  ACCOUNTS_UPDATE_ADMIN,
  buildAccountMetas,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

/**
 * Transfer the admin authority (header.admin) via UpdateAuthority { kind: ADMIN }.
 * Both the current admin AND the new admin must sign (unless burning to
 * default/zero, in which case only the current admin signs).
 */
export function registerUpdateAdmin(program: Command): void {
  program
    .command("update-admin")
    .description("Transfer admin authority to a new pubkey (UpdateAuthority kind=ADMIN)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--new-admin <pubkey>", "New admin public key (use 11111...1 to burn)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const newAdmin = validatePublicKey(opts.newAdmin, "--new-admin");

      const ixData = encodeUpdateAuthority({
        kind: AUTHORITY_KIND.ADMIN,
        newPubkey: newAdmin,
      });

      const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [
        ctx.payer.publicKey, // current admin (signs)
        newAdmin,            // new admin (must also sign unless burn)
        slabPk,
      ]);

      const ix = buildIx({ programId: ctx.programId, keys, data: ixData });

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers: [ctx.payer],
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
        rpcUrl: config.rpcUrl,
        allowMainnet: flags.yesMainnet ?? false,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
