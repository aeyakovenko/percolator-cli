/**
 * Mainnet liquidator (one-shot, cron-driven).
 *
 * Reads the slab once. If any account has an open position, submits a
 * KeeperCrank with up to 2 candidates ranked by |position_basis_q|.
 * The engine reads Pyth fresh inside `keeper_crank_not_atomic`, so it
 * is the authoritative MM gate; over-submission is safe (a healthy
 * account is a no-op fee sync).
 *
 * Why no off-chain MM filter:
 *   `engine.last_oracle_price` is written only inside `accrue_market_to`
 *   (called from oracle-reading instructions). Between cron ticks on a
 *   quiet market it can lag by the full crank interval. An off-chain
 *   gate computed from the lagged price systematically *under*-flags
 *   when price has moved against a position, which is the case that
 *   most needs liquidation. The ~5,000-lamport fee saved per quiet
 *   tick is not worth a missed liquidation during a real price move.
 *
 * callerIdx = 65535 (permissionless). Liquidation fees flow to insurance.
 *
 * Exit codes: 0 always. Emits a single LIQ_* tagged line per tick.
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
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const slab = new PublicKey(m.slab);
  const oracle = new PublicKey(m.oracle);
  const program = new PublicKey(m.programId);
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
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

  const open: { idx: number; absPos: bigint }[] = [];
  for (const i of used) {
    const a = parseAccount(data, i);
    if (a.positionBasisQ === 0n) continue;
    open.push({ idx: i, absPos: abs(a.positionBasisQ) });
  }

  if (open.length === 0) {
    console.log(`[${iso}] LIQ_IDLE  nUsed=${used.length} no open positions`);
    return;
  }

  open.sort((a, b) => a.absPos < b.absPos ? 1 : (a.absPos > b.absPos ? -1 : 0));
  const top = open.slice(0, 2);
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

  const postData = await fetchSlab(conn, slab);
  const post = parseEngine(postData);
  const postUsed = new Set(parseUsedIndices(postData));
  const insDelta = post.insuranceFund.balance - preInsurance;
  const liquidated = [...preUsed].filter(x => !postUsed.has(x));
  const candList = top.map(c => `${c.idx}(|p|=${c.absPos})`).join(",");
  const tag = liquidated.length > 0 ? "LIQ_FIRE" : "LIQ_SYNC";
  console.log(`[${iso}] ${tag}  sig=${sig.slice(0, 24)}... cands=[${candList}] liquidated=[${liquidated.join(",") || "none"}] insDelta=${insDelta}`);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] LIQ_ERROR ${e.message ?? e}`);
  process.exit(1);
});
