import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeUpdateAuthority, AUTHORITY_KIND } from "../abi/instructions.js";
import { ACCOUNTS_SET_ORACLE_AUTHORITY, buildAccountMetas } from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";
import { fetchSlab, parseHeader } from "../solana/slab.js";

/**
 * Set/rotate oracle authority via UpdateAuthority { kind: ORACLE }.
 */
export function registerSetOracleAuthority(program: Command): void {
  program
    .command("set-oracle-authority")
    .description("Set oracle authority (UpdateAuthority kind=ORACLE)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--authority <pubkey>", "New oracle authority public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const newAuthority = validatePublicKey(opts.authority, "--authority");

      // Fetch slab header to get current oracle authority
      const slabData = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const slabHeader = parseHeader(slabData);
      const currentAuthority = slabHeader.insuranceAuthority;

      const ixData = encodeUpdateAuthority({
        kind: AUTHORITY_KIND.ORACLE,
        newPubkey: newAuthority,
      });

      // UpdateAuthority: [current_authority, new_authority, slab].
      // When new == current (self-update) it still must be passed twice
      // so the decode sees two signer-capable keys.
      const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
        currentAuthority,
        newAuthority,
        slabPk,
      ]);

      const ix = buildIx({ programId: ctx.programId, keys, data: ixData });

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
