/**
 * Mainnet liquidator (one-shot, cron-driven at 60 s).
 *
 * Reads the slab. If any account has a non-zero position, submits a
 * permissionless `KeeperCrank` with the two largest |position_basis_q|
 * as `FullClose` candidates. The engine's `keeper_crank_not_atomic`
 * uses the fresh Pyth price passed from the wrapper and is authoritative:
 * if an account is healthy it's a no-op fee sync, if it's below MM it
 * gets liquidated and the fee flows to insurance.
 *
 * No off-chain MM gate: `engine.last_oracle_price` is only written when
 * an oracle-reading instruction (crank/trade/settle/liquidate/catchup)
 * lands, so between cron ticks it can lag by the full crank interval.
 * A gate computed from that value would under-flag exactly when price
 * has moved — the case that most needs liquidation. The engine's
 * on-chain check reads Pyth fresh each call, so over-submission is
 * strictly safe; the saved ~5000-lamport signature per quiet minute
 * (~0.0072 SOL/day ≈ $0.63/day at SOL=$87) is not worth the missed-
 * liquidation risk.
 *
 * callerIdx = 65535 (permissionless). We don't run as an LP so we don't
 * earn the 50% maintenance-fee reward kickback, but liquidation fees
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
import { parseEngine, parseAccount, parseUsedIndices, fetchSlab } from "../src/solana/slab.js";

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
  const used = parseUsedIndices(data);

  // Collect every account with an open position. The engine's on-chain
  // MM check (with fresh Pyth) is the authoritative filter.
  type Cand = { idx: number; absPos: bigint };
  const cands: Cand[] = [];
  for (const i of used) {
    const a = parseAccount(data, i);
    if (a.positionBasisQ === 0n) continue;
    cands.push({ idx: i, absPos: abs(a.positionBasisQ) });
  }

  if (cands.length === 0) {
    console.log(`[${iso}] LIQ_IDLE  nUsed=${used.length} no open positions`);
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
  const candList = top.map(c => `${c.idx}(|pos|=${c.absPos})`).join(",");
  const tag = liquidated.length > 0 ? "LIQ_FIRE" : "LIQ_SYNC";
  console.log(`[${iso}] ${tag}  sig=${sig.slice(0, 24)}... cands=[${candList}] liquidated=[${liquidated.join(",") || "none"}] insDelta=${insDelta}`);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] LIQ_ERROR ${e.message ?? e}`);
  process.exit(1);
});
