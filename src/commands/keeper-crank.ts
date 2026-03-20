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
  fetchSlab,
  parseUsedIndices,
  parseAccount,
  parseEngine,
  parseParams,
} from "../solana/slab.js";
import {
  validatePublicKey,
  validateIndex,
} from "../validation.js";

// Sentinel value for permissionless crank (no caller account required)
const CRANK_NO_CALLER = 65535; // u16::MAX

/**
 * Compute optimal liquidation candidates off-chain.
 * Returns account indices sorted by margin shortfall (most undercollateralized first).
 */
function computeCandidates(data: Buffer, oraclePrice: bigint): number[] {
  const indices = parseUsedIndices(data);
  const params = parseParams(data);
  const mmBps = params.maintenanceMarginBps;

  const scored: { idx: number; shortfall: bigint }[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const posQ = acc.positionBasisQ < 0n ? -acc.positionBasisQ : acc.positionBasisQ;
    if (posQ === 0n) continue; // Skip flat accounts

    // Notional = |pos| * price / 1e6
    const notional = (posQ * oraclePrice) / 1_000_000n;
    // MM_req = notional * mm_bps / 10000
    const mmReq = (notional * mmBps) / 10_000n;
    // Equity ~= capital + pnl (simplified, ignores warmup/ADL effects)
    const equity = BigInt.asIntN(128, acc.capital) + acc.pnl;

    if (equity < mmReq) {
      scored.push({ idx, shortfall: mmReq - equity });
    }
  }

  // Sort by shortfall descending (most undercollateralized first)
  scored.sort((a, b) => (b.shortfall > a.shortfall ? 1 : b.shortfall < a.shortfall ? -1 : 0));
  return scored.map(s => s.idx);
}

export function registerKeeperCrank(program: Command): void {
  program
    .command("keeper-crank")
    .description("Execute keeper crank with off-chain liquidation candidate shortlist")
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

      // Fetch slab data and compute liquidation candidates off-chain
      const slabData = await fetchSlab(ctx.connection, slabPk);
      const engine = parseEngine(slabData);
      const candidates = computeCandidates(slabData, engine.lastOraclePrice > 0n ? engine.lastOraclePrice : 1n);

      // Build instruction data with candidate shortlist
      const ixData = encodeKeeperCrank({
        callerIdx,
        allowPanic,
        candidates,
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
