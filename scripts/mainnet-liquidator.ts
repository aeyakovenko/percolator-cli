/**
 * Mainnet liquidator (one-shot, cron-driven at 60 s).
 *
 * Reads the slab once. If any active account has a non-zero position,
 * submits a permissionless `KeeperCrank` with the TWO largest-|position|
 * accounts as FullClose candidates. The engine's `keeper_crank_not_atomic`
 * runs the definitive margin check per candidate:
 *   - Below maintenance margin → liquidated, position closed, fee to insurance.
 *   - Healthy → candidate is a no-op (fees synced, nothing closed).
 *
 * callerIdx = 65535 (permissionless). We don't run as an LP, so we don't
 * earn the 50 % maintenance-fee reward kickback — but any liquidation
 * fees still flow to insurance and the market stays solvent.
 *
 * Exit codes: 0 on success/idle/resolved, 1 on any error. Emits one
 * LIQ_* tagged line for the cron log.
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

  // Collect accounts with non-zero positions.
  type Risky = { idx: number; absPos: bigint };
  const risky: Risky[] = [];
  for (const i of used) {
    const a = parseAccount(data, i);
    if (a.positionBasisQ === 0n) continue;
    const absPos = a.positionBasisQ < 0n ? -a.positionBasisQ : a.positionBasisQ;
    risky.push({ idx: i, absPos });
  }
  if (risky.length === 0) {
    console.log(`[${iso}] LIQ_IDLE  nUsed=${used.length} no open positions`);
    return;
  }

  // Bigint-safe descending sort: LARGEST |position| first. LIQ_BUDGET_PER_CRANK = 2.
  risky.sort((a, b) => a.absPos < b.absPos ? 1 : (a.absPos > b.absPos ? -1 : 0));
  const candidates = risky.slice(0, 2).map(r => ({ idx: r.idx, policyTag: 0 as const }));

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
      data: encodeKeeperCrank({ callerIdx: 65535, candidates }),
    }));

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed", skipPreflight: true,
  });

  const post = parseEngine(await fetchSlab(conn, slab));
  const postUsed = new Set(parseUsedIndices(await fetchSlab(conn, slab)));
  const insDelta = post.insuranceFund.balance - preInsurance;
  const liquidated = [...preUsed].filter(x => !postUsed.has(x));

  const candList = candidates.map(c => `idx${c.idx}`).join(",");
  const posList = risky.slice(0, 2).map(r => `${r.idx}:${r.absPos}`).join(",");
  const tag = liquidated.length > 0 ? "LIQ_FIRE" : "LIQ_SYNC";
  console.log(`[${iso}] ${tag}  sig=${sig.slice(0, 24)}... cands=[${candList}] (|pos|=${posList}) liquidated=[${liquidated.join(",") || "none"}] insDelta=${insDelta}`);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] LIQ_ERROR ${e.message ?? e}`);
  process.exit(1);
});
