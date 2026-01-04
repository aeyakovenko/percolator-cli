import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeSetRiskThreshold } from "../abi/instructions.js";
import {
  ACCOUNTS_SET_RISK_THRESHOLD,
  buildAccountMetas,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerSetRiskThreshold(program: Command): void {
  program
    .command("set-risk-threshold")
    .description("Set risk reduction threshold (admin only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--new-threshold <string>", "New risk threshold (u128)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);

      // Build instruction data
      const ixData = encodeSetRiskThreshold({ newThreshold: opts.newThreshold });

      // Build account metas (order matches ACCOUNTS_SET_RISK_THRESHOLD)
      const keys = buildAccountMetas(ACCOUNTS_SET_RISK_THRESHOLD, [
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
