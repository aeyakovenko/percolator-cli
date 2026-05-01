import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeResolveMarket } from "../abi/instructions.js";
import { ACCOUNTS_RESOLVE_MARKET, buildAccountMetas, WELL_KNOWN } from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey, validateU16 } from "../validation.js";

export function registerResolveMarket(program: Command): void {
  program
    .command("resolve-market")
    .description("Resolve binary market (admin only, requires oracle price to be set)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .option("--mode <number>", "Resolution mode: 0=Ordinary (default), 1=Degenerate (v12.21+)", "0")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const oraclePk = validatePublicKey(opts.oracle, "--oracle");

      // Validate mode: 0=Ordinary, 1=Degenerate (v12.21+)
      const mode = validateU16(opts.mode, "--mode");
      if (mode !== 0 && mode !== 1) {
        throw new Error("--mode must be 0 (Ordinary) or 1 (Degenerate)");
      }

      const ixData = encodeResolveMarket({ mode });
      const keys = buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [
        ctx.payer.publicKey, // admin (signer)
        slabPk, // slab (writable)
        WELL_KNOWN.clock, // clock
        oraclePk, // oracle
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
