/**
 * Mainnet liquidator (one-shot, cron-driven at 60 s).
 *
 * Reads the slab once. Computes off-chain the engine's
 * `is_above_maintenance_margin` predicate per account and ONLY submits a
 * crank if at least one account appears to be below MM. This avoids
 * wasting a ~5000-lamport signature fee every minute during healthy
 * periods. The engine re-checks on-chain before liquidating, so a
 * false-positive candidate is a no-op there.
 *
 * Off-chain heuristic (matches engine §9.1 modulo ADL credits):
 *
 *   released_pnl = pnl - reserved_pnl            // engine's effective_matured_pnl
 *                                                // for non-ADL'd accounts equals
 *                                                // released positive PnL
 *   eq_approx    = capital + min(pnl, 0) + max(0, released_pnl)
 *                                              - max(0, -fee_credits)
 *   notional     = |position_basis_q| * last_oracle_price / POS_SCALE(1_000_000)
 *   mm_req       = max(notional * mm_bps / 10000, min_nonzero_mm_req)
 *   LIQUIDATABLE iff eq_approx <= mm_req
 *
 * If the off-chain check fires, submit `KeeperCrank` with up to 2
 * liquidation-candidate accounts (LARGEST |position| first), FullClose
 * policy. Engine's `keeper_crank_not_atomic` runs the definitive check.
 *
 * callerIdx = 65535 (permissionless). We don't run as an LP so we don't
 * earn the 50 % maintenance-fee reward kickback, but liquidation fees
 * flow to insurance and the market stays solvent.
 *
 * Exit codes: 0 always (idle counts as success). Emits a single LIQ_*
 * tagged line to the cron log.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { ACCOUNTS_KEEPER_CRANK, buildAccountMetas, WELL_KNOWN } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { parseEngine, parseParams, parseAccount, parseUsedIndices, fetchSlab } from "../src/solana/slab.js";

const POS_SCALE = 1_000_000n;

function abs(x: bigint): bigint { return x < 0n ? -x : x; }

async function main() {
  const manifest = process.env.MARKET_MANIFEST || "mainnet-market.json";
  const m = JSON.parse(fs.readFileSync(manifest, "utf-8"));
  const slab = new PublicKey(m.slab);
  const oracle = new PublicKey(m.oracle);
  const program = new PublicKey(m.programId);
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const iso = new Date().toISOString();

  const data = await fetchSlab(conn, slab);
  const e = parseEngine(data);
  if (e.marketMode !== 0) {
    console.log(`[${iso}] LIQ_HALT  market_mode=Resolved — nothing to do`);
    return;
  }
  const p = parseParams(data);
  const used = parseUsedIndices(data);
  const price = e.lastOraclePrice;

  if (price === 0n) {
    console.log(`[${iso}] LIQ_IDLE  engine.last_oracle_price=0 (pre-first-crank)`);
    return;
  }

  // Collect liquidation candidates via off-chain health check.
  type Cand = { idx: number; absPos: bigint; eq: bigint; mmReq: bigint };
  const cands: Cand[] = [];
  for (const i of used) {
    const a = parseAccount(data, i);
    if (a.positionBasisQ === 0n) continue;
    const absPos = abs(a.positionBasisQ);
    const notional = (absPos * price) / POS_SCALE;
    const proportional = (notional * p.maintenanceMarginBps) / 10_000n;
    const mmReq = proportional > p.minNonzeroMmReq ? proportional : p.minNonzeroMmReq;
    // eq_approx = capital + min(pnl, 0) + max(0, pnl - reservedPnl) - max(0, -fee_credits)
    const negPnl = a.pnl < 0n ? a.pnl : 0n;
    const releasedPnl = a.pnl - a.reservedPnl;
    const positiveReleased = releasedPnl > 0n ? releasedPnl : 0n;
    const feeDebt = a.feeCredits < 0n ? -a.feeCredits : 0n;
    const eq = BigInt(a.capital) + negPnl + positiveReleased - feeDebt;
    if (eq <= mmReq) cands.push({ idx: i, absPos, eq, mmReq });
  }

  if (cands.length === 0) {
    console.log(`[${iso}] LIQ_IDLE  nUsed=${used.length} all accounts above MM`);
    return;
  }

  // Sort: largest |position| first. LIQ_BUDGET_PER_CRANK = 2.
  cands.sort((a, b) => a.absPos < b.absPos ? 1 : (a.absPos > b.absPos ? -1 : 0));
  const top = cands.slice(0, 2);
  const txCands = top.map(c => ({ idx: c.idx, policyTag: 0 as const }));

  const preInsurance = e.insuranceFund.balance;
  const preUsed = new Set(used);

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))
    .add(buildIx({
      programId: program,
      keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey, slab, WELL_KNOWN.clock, oracle,
      ]),
      data: encodeKeeperCrank({ callerIdx: 65535, candidates: txCands }),
    }));

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed", skipPreflight: true,
  });

  const post = parseEngine(await fetchSlab(conn, slab));
  const postUsed = new Set(parseUsedIndices(await fetchSlab(conn, slab)));
  const insDelta = post.insuranceFund.balance - preInsurance;
  const liquidated = [...preUsed].filter(x => !postUsed.has(x));
  const candList = top.map(c => `${c.idx}(eq=${c.eq},mm=${c.mmReq})`).join(",");
  const tag = liquidated.length > 0 ? "LIQ_FIRE" : "LIQ_SYNC";
  console.log(`[${iso}] ${tag}  sig=${sig.slice(0, 24)}... cands=[${candList}] liquidated=[${liquidated.join(",") || "none"}] insDelta=${insDelta}`);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] LIQ_ERROR ${e.message ?? e}`);
  process.exit(1);
});
