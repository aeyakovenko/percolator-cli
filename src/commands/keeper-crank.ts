import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeKeeperCrank } from "../abi/instructions.js";
import {
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerKeeperCrank(program: Command): void {
  program
    .command("keeper-crank")
    .description("Execute keeper crank operation")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--caller-idx <number>", "Caller account index")
    .requiredOption("--funding-rate-bps-per-slot <string>", "Funding rate (bps per slot, signed)")
    .requiredOption("--allow-panic", "Allow panic mode")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const oracle = new PublicKey(opts.oracle);
      const callerIdx = parseInt(opts.callerIdx, 10);
      const allowPanic = opts.allowPanic === true;

      // Build instruction data
      const ixData = encodeKeeperCrank({
        callerIdx,
        fundingRateBpsPerSlot: opts.fundingRateBpsPerSlot,
        allowPanic,
      });

      // Build account metas (order matches ACCOUNTS_KEEPER_CRANK)
      const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        ctx.payer.publicKey, // caller
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
