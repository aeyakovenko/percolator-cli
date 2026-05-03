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
  validateU32,
} from "../validation.js";

// Sentinel value for permissionless crank (no caller account required)
const CRANK_NO_CALLER = 65535; // u16::MAX

/**
 * Compute effective position accounting for ADL multiplier adjustments.
 * On-chain: effective_pos_q = basis * adl_mult_side / adl_a_basis
 * If epoch mismatch, effective position is 0.
 */
function effectivePosQ(acc: ReturnType<typeof parseAccount>, engine: ReturnType<typeof parseEngine>): bigint {
  const basis = acc.positionBasisQ;
  if (basis === 0n) return 0n;

  const isLong = basis > 0n;
  const epochSide = isLong ? engine.adlEpochLong : engine.adlEpochShort;
  if (acc.adlEpochSnap !== epochSide) return 0n; // epoch mismatch → flat

  const aBasis = acc.adlABasis;
  if (aBasis === 0n) return 0n;

  const aSide = isLong ? engine.adlMultLong : engine.adlMultShort;
  // effective = basis * a_side / a_basis (truncated toward zero)
  return (basis * BigInt.asIntN(128, aSide)) / BigInt.asIntN(128, aBasis);
}

/**
 * Compute liquidation candidates off-chain.
 *
 * IMPORTANT: In v11.26, account PnL is only updated when the crank TOUCHES the
 * account. Stale PnL means we can't reliably determine which accounts are underwater
 * just from stored state. We must submit ALL accounts with non-zero effective positions
 * as candidates so the on-chain crank touches them, updates their PnL via ADL
 * coefficients, and then checks margin.
 *
 * Accounts are sorted by leverage (highest first) to prioritize the most at-risk.
 * The engine's budget limit (LIQ_BUDGET_PER_CRANK=64) caps how many get processed.
 */
function computeCandidates(data: Buffer, engine: ReturnType<typeof parseEngine>): number[] {
  const indices = parseUsedIndices(data);
  const oraclePrice = engine.lastOraclePrice > 0n ? engine.lastOraclePrice : 1n;
  const POS_SCALE = 1_000_000n;

  const scored: { idx: number; leverage: bigint }[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);

    // Use effective position (ADL-adjusted)
    const effPos = effectivePosQ(acc, engine);
    const absPos = effPos < 0n ? -effPos : effPos;
    if (absPos === 0n) continue;

    // Notional = |effective_pos| * oracle_price / POS_SCALE
    const notional = (absPos * oraclePrice) / POS_SCALE;
    const capital = acc.capital > 0n ? acc.capital : 1n;

    // leverage = notional / capital (higher = more at risk)
    const leverage = (notional * 10_000n) / capital;

    scored.push({ idx, leverage });
  }

  // Sort by leverage descending (highest leverage = most at risk first)
  scored.sort((a, b) => (b.leverage > a.leverage ? 1 : b.leverage < a.leverage ? -1 : 0));
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

      // Fetch slab data and compute liquidation candidates off-chain
      const slabData = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const engine = parseEngine(slabData);
      const candidates = computeCandidates(slabData, engine);

      // Build instruction data with candidate shortlist
      const ixData = encodeKeeperCrank({
        callerIdx,
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
        ? validateU32(opts.computeUnits, "--compute-units")
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
