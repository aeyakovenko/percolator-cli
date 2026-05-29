/** Minimal-cost continuous cranker: keep m0 & m2 within max_accrual_dt (20 slots ≈ 8s)
 * of the clock so they stay trade-ready. ZERO priority fee (base 5,000 lamports/tx only);
 * both assets cranked in ONE tx per cycle. Keeper key. ~55s loop (run per-minute via cron).
 * m1 (STOXX) is skipped — closed feed; needs an admin ConfigureHybridOracle re-anchor at EU
 * hours before it can be maintained here.
 * ONESHOT=1 → single cycle (for testing). CADENCE_MS overrides the ~7s default. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import { encPermissionlessCrank } from "../src/v16/index.js";
import { parseMarketGroup } from "../src/v16/parsers.js";

const HOME = process.env.HOME!;
const RPC = process.env.SOLANA_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const PROGRAM_ID = new PublicKey(M.programId), MARKET = new PublicKey(M.market);
const KEEPER = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.KEEPER_KEYPAIR ?? `${HOME}/.config/solana/bounty5-keeper.json`, "utf8"))));
const KEEPER_PF = new PublicKey(M.keeperPortfolio);
const CADENCE_MS = Number(process.env.CADENCE_MS ?? 7000);
const RUN_MS = Number(process.env.RUN_MS ?? 55000);
const ASSETS = [{ idx: 0, accts: M.markets[0].oracleAccounts.map((a: string) => new PublicKey(a)) },
                { idx: 2, accts: M.markets[2].oracleAccounts.map((a: string) => new PublicKey(a)) }];
const ts = () => new Date().toISOString().slice(11, 19);
const code = (e: any) => { const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + (e?.message ?? ""); return s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? s.match(/"Custom":\s*(\d+)/)?.[1] ?? (s.slice(0, 50) || "?"); };

function crankIx(idx: number, accts: PublicKey[], slot: bigint) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: KEEPER.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true },
    { pubkey: KEEPER_PF, isSigner: false, isWritable: true }, ...accts.map(a => ({ pubkey: a, isSigner: false, isWritable: false }))],
    data: encPermissionlessCrank({ action: 0, assetIndex: idx, nowSlot: slot, fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) });
}
async function gaps(): Promise<Record<number, bigint>> {
  const now = BigInt(await conn.getSlot("confirmed"));
  const g: any = parseMarketGroup(Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data));
  const out: Record<number, bigint> = {};
  for (const a of ASSETS) { const sl = BigInt(g.assets.find((x: any) => x.index === a.idx)?.slotLast ?? 0n); out[a.idx] = now - sl; }
  return out;
}

const CHUNK = 9;                   // crank-ixs per tx (under the 1232-byte tx-size limit)
const MAX_CRANKS_PER_ASSET = 27;   // per-cycle catch-up cap (3 chunks); beyond → next cycle
const HUGE_GAP = 5000;             // beyond this an asset needs an admin re-anchor, not cranks (skip)
async function sendChunk(ixs: TransactionInstruction[]): Promise<boolean> {
  const { sendAndConfirmTransaction } = await import("@solana/web3.js");
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 120_000 + ixs.length * 80_000) }), ...ixs);
  try { await sendAndConfirmTransaction(conn, tx, [KEEPER], { commitment: "confirmed", skipPreflight: true }); return true; }
  catch (e: any) { console.log(`${ts()} chunk fail (${ixs.length} cranks): ${code(e)}`); return false; }
}
(async () => {
  const oneshot = process.env.ONESHOT === "1";
  const end = Date.now() + RUN_MS;
  let sent = 0, failed = 0;
  do {
    const slot = BigInt(await conn.getSlot("confirmed"));
    const g = await gaps();
    const ixs: TransactionInstruction[] = []; const plan: string[] = [];
    for (const a of ASSETS) {
      const gap = g[a.idx];
      if (gap > BigInt(HUGE_GAP)) { plan.push(`m${a.idx}:SKIP(${gap})`); continue; }
      const n = Math.min(MAX_CRANKS_PER_ASSET, Math.max(1, Math.ceil(Number(gap) / 20)));
      for (let i = 0; i < n; i++) ixs.push(crankIx(a.idx, a.accts, slot));
      plan.push(`m${a.idx}:${n}`);
    }
    // chunk the crank-ixs across txs (≤CHUNK each); zero priority (base fee only)
    for (let i = 0; i < ixs.length; i += CHUNK) { (await sendChunk(ixs.slice(i, i + CHUNK))) ? sent++ : failed++; }
    if (oneshot) break;
    if (Date.now() < end) await new Promise(r => setTimeout(r, CADENCE_MS));
  } while (Date.now() < end);
  const g = await gaps();
  console.log(`${ts()} done txs_ok=${sent} txs_fail=${failed}  final gaps: m0=${g[0]} m2=${g[2]} (target <20; m1 deferred — STOXX closed)`);
})().catch(e => { console.log(`${ts()} FATAL: ${e.message || e}`); process.exit(1); });
