import { Command } from "commander";
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
import {
  validatePublicKey,
  validateIndex,
} from "../validation.js";

// Sentinel value for permissionless crank (no caller account required)
const CRANK_NO_CALLER = 65535; // u16::MAX

export function registerKeeperCrank(program: Command): void {
  program
    .command("keeper-crank")
    .description("Execute keeper crank operation (permissionless by default, funding rate computed on-chain)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .option("--caller-idx <number>", "Caller account index (default: 65535 for permissionless)")
    .option("--allow-panic", "Allow panic mode")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .option("--compute-units <number>", "Custom compute unit limit (default: 200000, max: 1400000)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      const oracle = validatePublicKey(opts.oracle, "--oracle");

      // Default to permissionless mode (caller_idx = 65535)
      const callerIdx = opts.callerIdx !== undefined
        ? validateIndex(opts.callerIdx, "--caller-idx")
        : CRANK_NO_CALLER;

      const allowPanic = opts.allowPanic === true;

      // Build instruction data (funding rate computed on-chain from LP inventory)
      const ixData = encodeKeeperCrank({
        callerIdx,
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

      // Parse compute unit limit if provided
      const computeUnitLimit = opts.computeUnits
        ? parseInt(opts.computeUnits, 10)
        : undefined;

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers: [ctx.payer],
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
        computeUnitLimit,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
