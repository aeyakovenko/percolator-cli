import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeLiquidateAtOracle } from "../abi/instructions.js";
import {
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerLiquidateAtOracle(program: Command): void {
  program
    .command("liquidate-at-oracle")
    .description("Liquidate an undercollateralized account at oracle price")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--target-idx <number>", "Target account index to liquidate")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const oracle = new PublicKey(opts.oracle);
      const targetIdx = parseInt(opts.targetIdx, 10);

      // Build instruction data
      const ixData = encodeLiquidateAtOracle({ targetIdx });

      // Build account metas (order matches ACCOUNTS_LIQUIDATE_AT_ORACLE)
      // Note: account[0] is unused but required
      const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
        ctx.payer.publicKey, // unused (but must be present)
        slabPk, // slab
        WELL_KNOWN.clock, // clock
        oracle, // oracle
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
