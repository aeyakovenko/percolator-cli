import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeSetOracleAuthority } from "../abi/instructions.js";
import { ACCOUNTS_SET_ORACLE_AUTHORITY, buildAccountMetas } from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

export function registerSetOracleAuthority(program: Command): void {
  program
    .command("set-oracle-authority")
    .description("Set oracle authority for binary/hyperp market (admin only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--authority <pubkey>", "New oracle authority public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const authority = validatePublicKey(opts.authority, "--authority");

      const ixData = encodeSetOracleAuthority({ newAuthority: authority });
      const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
        ctx.payer.publicKey,
        slabPk,
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
