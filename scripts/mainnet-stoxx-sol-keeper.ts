/** STOXX/SOL keeper for mainnet `4AXbMuJzrUv5…` (program `70294cb`).
 *
 * Single-asset successor to `mainnet-bounty5-v16-tick.ts` + `keep-within-20.ts`.
 * One cron tick per minute, dormant-when-empty for minimum cost.
 *
 *   - DORMANT (matz == 0 OR no positions): no cranks unless the asset is
 *     drifting toward the perm-resolve hard-stale window (30 days). One
 *     heartbeat crank every HEARTBEAT_SLOTS bumps slot_last without paying for
 *     anything more.
 *   - ACTIVE (any position open): keep asset 0 within TARGET_GAP slots of the
 *     clock by packing ⌈gap / max_accrual_dt⌉ crank ixs into one tx per cycle.
 *     Engine cap is 10 slots/crank (V16Config.max_accrual_dt_slots), so a
 *     20-slot target = 2 cranks per cycle. Zero priority fee — base 5,000
 *     lamports per tx only.
 *
 * Costs:
 *   - DORMANT: ~12 cranks/year (heartbeat) ≈ 0 SOL.
 *   - ACTIVE: ≤ 1 tx/min × 5,000 lamports = 0.0072 SOL/day ≈ \$0.50/day.
 *
 * The asset 0 mark is a 3-leg composite STOXX·EUR × EUR/USD ÷ SOL/USD. SOL/USD
 * is kept fresh by Pyth's sponsored cranks; STOXX·EUR + EUR/USD are self-pushed
 * here during EU market hours via the local pyth-pusher subprocess. Outside
 * those hours, oracle_mode = HYBRID_AFTER_HOURS holds the price via the EWMA.
 *
 * Env:
 *   KEEPER_KEYPAIR      — keeper SOL key (default ~/.config/solana/bounty5-keeper.json)
 *   KEEPER_PORTFOLIO    — keeper portfolio pubkey (default: from manifest)
 *   MANIFEST_PATH       — market manifest (default: mainnet-stoxx-sol-market.json)
 *   SOLANA_RPC_URL      — override RPC
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import { encPermissionlessCrank } from "../src/v16/index.js";
import { parseMarketGroup } from "../src/v16/parsers.js";

const HOME = process.env.HOME!;
const RPC = process.env.SOLANA_RPC_URL
  ?? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const MANIFEST_PATH = process.env.MANIFEST_PATH ?? `${HOME}/percolator-cli/mainnet-stoxx-sol-market.json`;
const M = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const PROGRAM_ID = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const KEEPER_KP = process.env.KEEPER_KEYPAIR ?? `${HOME}/.config/solana/bounty5-keeper.json`;
const KEEPER = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEEPER_KP, "utf8"))));
const KEEPER_PF = new PublicKey(process.env.KEEPER_PORTFOLIO ?? M.keeperPortfolio);
const ORACLE_ACCTS = M.asset0.oracleAccounts.map((a: string) => new PublicKey(a));
const FEED_STOXX_EUR = M.asset0.oracleLegFeeds[0];
const FEED_EUR_USD   = M.asset0.oracleLegFeeds[1];
const STOXX_ACCT = ORACLE_ACCTS[0], EUR_ACCT = ORACLE_ACCTS[1];

// Tuning knobs.
const TARGET_GAP = 20;                  // keep slot_last within this many slots of clock when active
const MAX_ACCRUAL_DT = 10;              // matches V16Config.max_accrual_dt_slots = 10 baked in at InitMarket
const MAX_CRANKS_PER_TICK = 9;          // tx-size cap (one tx per cron)
const HEARTBEAT_SLOTS = 5_000_000;      // dormant tick to dodge perm_resolve (~30 d). Crank if slot_last
                                        // is older than this many slots.
const HUGE_GAP = 100_000;               // beyond this an asset needs an admin re-anchor, skip cranks
const PUSHER_DIR = `${HOME}/pyth-pusher`;

const ts = () => new Date().toISOString().slice(11, 19);
const code = (e: any) => {
  const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + (e?.message ?? "");
  return s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? s.match(/"Custom":\s*(\d+)/)?.[1] ?? (s.slice(0, 60) || "?");
};

function crankIx(nowSlot: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: KEEPER.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: KEEPER_PF, isSigner: false, isWritable: true },
      ...ORACLE_ACCTS.map((a: PublicKey) => ({ pubkey: a, isSigner: false, isWritable: false })),
    ],
    data: encPermissionlessCrank({
      nowSlot,
      closeQ: 0n,
      observations: [{ assetIndex: 0, oracleAccounts: ORACLE_ACCTS.length }],
    }),
  });
}

async function sendCrankTx(ixs: TransactionInstruction[]): Promise<boolean> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 120_000 + ixs.length * 80_000) }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    ...ixs,
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [KEEPER], { commitment: "confirmed", skipPreflight: true });
    return true;
  } catch (e: any) {
    console.log(`${ts()} crank fail (${ixs.length} ixs): ${code(e)}`);
    return false;
  }
}

// Self-push STOXX·EUR + EUR/USD via the local pyth-pusher subprocess.
// Pyth has a SOL/USD sponsored crank, but STOXX + EUR aren't kept fresh on
// shard 0. Only push when both feeds are accepting submissions (in EU hours).
function selfPushPythLegs(): void {
  if (!fs.existsSync(`${PUSHER_DIR}/push.js`)) return;
  const env = { ...process.env, PATH: `/home/anatoly/.nvm/versions/node/v24.10.0/bin:${process.env.PATH ?? ""}` };
  for (const feed of [FEED_STOXX_EUR, FEED_EUR_USD]) {
    const r = spawnSync("node", [`${PUSHER_DIR}/push.js`, feed, "0", KEEPER_KP],
      { cwd: PUSHER_DIR, env, timeout: 30_000, encoding: "utf8" });
    if (r.status === 0) console.log(`${ts()} pushed feed ${feed.slice(0, 12)}…`);
  }
}

(async () => {
  const nowSlot = BigInt(await conn.getSlot("confirmed"));
  const ai = await conn.getAccountInfo(MARKET, "confirmed");
  if (!ai) { console.log(`${ts()} market account missing — exit`); return; }
  const g: any = parseMarketGroup(Buffer.from(ai.data));
  const asset0 = g.assets.find((a: any) => a.index === 0);
  const slotLast = BigInt(asset0?.slotLast ?? 0n);
  const gap = Number(nowSlot - slotLast);
  const matz = Number(g.materializedPortfolioCount);
  const cTot = BigInt(g.cTot);

  console.log(`${ts()} tick  slot=${nowSlot} asset0.slot_last=${slotLast} gap=${gap}  matz=${matz} c_tot=${cTot} ins=${g.insurance} vault=${g.vault}`);

  // ACTIVE: any portfolio with capital → keep within TARGET_GAP.
  // DORMANT: nothing to liquidate; only crank if the gap is approaching
  // perm_resolve_stale_slots (the heartbeat).
  const isActive = matz > 1 || cTot > 0n;   // keeper pf counts as matz=1 with zero cap

  let nCranks = 0;
  if (isActive) {
    // ACTIVE branch only — HUGE_GAP risks cascade settle so we bail and
    // require admin re-anchor.  In dormant the heartbeat path is safe at any
    // gap (action=0 with no positions can't cascade), so the guard does NOT
    // apply there.  Branch-order bug fixed 2026-06-10: previously the
    // HUGE_GAP early-return sat above the isActive/heartbeat dispatch and
    // made the dormant heartbeat unreachable for the entire range
    // HUGE_GAP < gap < HEARTBEAT_SLOTS.
    if (gap > HUGE_GAP) {
      console.log(`${ts()} ACTIVE+HUGE_GAP (${gap}) — admin ConfigureHybridOracle re-anchor needed, skip`);
      return;
    }
    // crank enough to land within TARGET_GAP of the clock
    nCranks = Math.min(MAX_CRANKS_PER_TICK, Math.max(1, Math.ceil(Math.max(0, gap - TARGET_GAP) / MAX_ACCRUAL_DT) + 1));
    console.log(`${ts()} ACTIVE — planning ${nCranks} crank(s) to reach ≤${TARGET_GAP} slots`);
    // STOXX requires fresh leg accounts; in-hours we self-push the closed legs.
    selfPushPythLegs();
  } else if (gap > HEARTBEAT_SLOTS / 50) {
    // DORMANT heartbeat — fire as soon as the gap exceeds ~2% of the auto-resolve
    // threshold so a single dormant tick reliably catches up before the gap can
    // exceed max_accrual_dt × MAX_CRANKS_PER_TICK on the next tick.  Use the
    // full crank budget so we make real progress even when slot_last has fallen
    // far behind.  HEARTBEAT_SLOTS/50 = 100K with HEARTBEAT_SLOTS=5M.
    nCranks = MAX_CRANKS_PER_TICK;
    console.log(`${ts()} DORMANT heartbeat — slot_last is ${gap} slots stale (>${Math.floor(HEARTBEAT_SLOTS/50)}); cranking ${nCranks}x to catch up`);
    selfPushPythLegs();
  } else {
    console.log(`${ts()} DORMANT — no positions and gap=${gap} < ${Math.floor(HEARTBEAT_SLOTS/50)}, no cranks`);
    return;
  }

  if (nCranks > 0) {
    const ixs: TransactionInstruction[] = [];
    for (let i = 0; i < nCranks; i++) ixs.push(crankIx(nowSlot));
    const ok = await sendCrankTx(ixs);
    const ai2 = await conn.getAccountInfo(MARKET, "confirmed");
    if (ai2) {
      const g2: any = parseMarketGroup(Buffer.from(ai2.data));
      const a0 = g2.assets.find((a: any) => a.index === 0);
      const newGap = Number(BigInt(await conn.getSlot("confirmed")) - BigInt(a0?.slotLast ?? 0n));
      console.log(`${ts()} done   ok=${ok ? 1 : 0}  final gap=${newGap}`);
    }
  }
})().catch(e => { console.log(`${ts()} FATAL: ${e?.message || e}`); process.exit(1); });
