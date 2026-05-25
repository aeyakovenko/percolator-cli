/**
 * v16 BOUNTY-5 KEEPER TICK — PROXIMITY-DRIVEN. ONE cron invocation.
 *
 * The keeper's real job is to keep the market solvent at minimum cost. A v16
 * position can only become liquidatable ON-CHAIN when the stored mark moves,
 * and the mark only moves when someone cranks. So the cheapest safe strategy is
 * to crank/liquidate ONLY when an open position is near its liquidation level —
 * and otherwise do nothing but a rare heartbeat to dodge the 30-day hard-stale.
 *
 * Each cron run (once/min):
 *   1. Read the market (per-asset mark + slot_last + oracle mode) and discover
 *      every portfolio. Compute each position's health buffer OFF-CHAIN from the
 *      stored mark (capital + pnl − fee_debt  vs  Σ maintenance_req). No tx.
 *   2. Classify each asset by the worst position on it:
 *        HOT  — a position is at/near liq (bufferRatio < HOT_RATIO) or its mark
 *               is too stale to trust → tight crank+liquidate burst on that asset.
 *        WARM — a position has a modest buffer → one refresh crank + one liq probe.
 *        COLD — a position is comfortably far AND the mark is fresh → skip (no tx).
 *        IDLE — no positions → heartbeat: crank once only if the oracle-staleness
 *               clock is aging toward the hard-stale limit.
 *   3. Crank in SMALL steps during a burst (each accrual ≤ max_accrual_dt, so the
 *      mark walks ≤ max_price_move·dt) and liquidate as the mark crosses, bounding
 *      bad debt. The engine is the source of truth: action:1 no-ops (0x15/0x16) on
 *      a healthy account, so an over-eager burst can never wrongly liquidate.
 *
 * Safety: under-cranking is the only dangerous failure (a real liq missed → bad
 * debt). The conservative knobs (generous HOT_RATIO above one crank step, the
 * mark-freshness gate forcing a refresh when stale, and the engine as final
 * arbiter) make the keeper err toward cranking, never toward skipping a live risk.
 *
 *   NETWORK=mainnet KEEPER_KEYPAIR=$HOME/.config/solana/bounty5-keeper.json \
 *   KEEPER_PORTFOLIO=<pubkey> tsx scripts/mainnet-bounty5-v16-tick.ts
 *
 * Env: NETWORK (mainnet|devnet) · KEEPER_KEYPAIR · KEEPER_PORTFOLIO · SOLANA_RPC_URL
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  encPermissionlessCrank,
  MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN,
} from "../src/v16/index.js";
import { parseAsset, parseAssetOracleProfile } from "../src/v16/parsers.js";
import { discoverPortfolios } from "../src/v16/discover.js";

// ============================================================================
// Config / environment
// ============================================================================
const HOME = process.env.HOME!;
const NETWORK = (process.env.NETWORK ?? "mainnet").toLowerCase();
const PUSHER_DIR = `${HOME}/pyth-pusher`;

function mainnetRpc(): string {
  return `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
}
function devnetRpc(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  try {
    const line = fs.readFileSync(`${HOME}/percolator-cli/.env`, "utf8").trim();
    const idx = line.indexOf("=");
    if (idx > 0) return line.slice(idx + 1).trim();
  } catch { /* fall through */ }
  return "https://api.devnet.solana.com";
}

const RPC = NETWORK === "mainnet" ? mainnetRpc() : devnetRpc();
const MANIFEST_PATH = NETWORK === "mainnet"
  ? `${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`
  : `${HOME}/percolator-cli/bounty5-v16-devnet.json`;
const M = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

const PROGRAM_ID = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const conn = new Connection(RPC, "confirmed");

const KEEPER_KEYPAIR_PATH = process.env.KEEPER_KEYPAIR ?? `${HOME}/.config/solana/bounty5-keeper.json`;
const keeper = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEEPER_KEYPAIR_PATH, "utf8"))));
const KEEPER_PORTFOLIO = new PublicKey(process.env.KEEPER_PORTFOLIO ?? M.keeperPortfolio ?? (() => {
  throw new Error("KEEPER_PORTFOLIO env (or manifest.keeperPortfolio) is required");
})());

// Pyth feed IDs (32-byte hex). Only self-push the legs nobody else maintains:
// SOL/USD + BTC/USD shard-0 are kept fresh by Pyth's sponsored cranks; only m1's
// STOXX + EUR legs are self-maintained, and only inside their market hours.
const FEED_STOXX_EUR = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
const FEED_EUR_USD   = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";

const SOL = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const EUR = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const BTC = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
// Per-asset crank oracle accounts when in a hybrid/manual mode. AUTH_MARK / EWMA
// assets read no external oracle, so they crank with an empty tail (see crankIx).
const ASSET_ORACLE_ACCTS: Record<number, PublicKey[]> = {
  0: [SOL],
  1: [STOXX, EUR, SOL],
  2: [BTC, SOL],
};
// feed → its self-push (Pyth pull) account + feed-id, for the in-hours m1 legs.
const PUSH_LEGS: { feed: string; acct: PublicKey }[] = [
  { feed: FEED_STOXX_EUR, acct: STOXX },
  { feed: FEED_EUR_USD, acct: EUR },
];

// ---- risk config (immutable, from the deploy) ----
const MM_BPS = BigInt(M.maintenanceMarginBps ?? 500);     // 5% = 20× leverage
const MIN_MM_REQ = 500n;                                  // min_nonzero_mm_req (lamports)
const POS_SCALE = 1_000_000n;
const MAX_ACCRUAL_DT = 20n;

// ---- proximity thresholds ----
// bufferRatio = (equity − maintenance) / maintenance. A position is liquidatable
// at bufferRatio < 0. One crank step moves the mark ≤ max_price_move·max_dt =
// 24·20 = 480 bps ≈ 0.96 maintenance-widths, so HOT must trigger above that.
const HOT_RATIO = 1.5;        // burst when within ~1.5 maintenance-widths of liq
const WARM_RATIO = 4.0;       // single refresh + probe when within ~4 widths
const FRESH_SLOTS = 300n;     // a position's mark older than this → can't trust the
                              // off-chain buffer → force at least a WARM refresh
// idle strategy = DORMANT: only crank to dodge the ~30-day hard-stale
// (permissionless_resolve_stale_slots = 6_480_000). Heartbeat at ~23 days leaves
// a ~7-day margin for the next tick to land the reset. An idle market is meant to
// drift stale (near-zero cost, no m1 pushes); a trader/bounty-hunter catches it up.
// Liquidation (action:1) is NOT loss_stale-gated, so safety holds while it drifts.
const HEARTBEAT_SLOTS = 5_000_000n;
// burst pacing
const BURST_CYCLES = 10;
const BURST_MS = 6_000;
const WSOL_REWARD_WRAP = 2_000_000n;

// oracle modes (percolator-prog constants)
const ORACLE_MODE_AUTH_MARK = 3;
const ORACLE_MODE_EWMA_MARK = 2;
function readsExternalOracle(mode: number): boolean {
  return mode !== ORACLE_MODE_AUTH_MARK && mode !== ORACLE_MODE_EWMA_MARK;
}

const withCu = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROGRAM_ID)[0];
const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
const keeperWsol = getAssociatedTokenAddressSync(NATIVE_MINT, keeper.publicKey);

const send = (ixs: TransactionInstruction[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...withCu(), ...ixs), [keeper],
    { commitment: "confirmed", skipPreflight: true });

function errCode(e: any): string {
  const logs = ((e?.transactionLogs ?? e?.logs) ?? []).join(" ");
  const msg = String(e?.message ?? "");
  // hex form (preflight) or JSON {"Custom":N} form (skipPreflight confirmation error)
  const hex = (logs + " " + msg).match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
  if (hex) return hex;
  const dec = msg.match(/"Custom":\s*(\d+)/)?.[1];
  if (dec) return "0x" + Number(dec).toString(16);
  return msg.slice(0, 60) || "unknown";
}
const HEALTHY = (c: string) => c === "0x15" || c === "0x16"; // lock/non-progress = healthy no-op

let cranksOk = 0, cranksFail = 0, liqDone = 0, liqAttempt = 0, pushes = 0;

// ============================================================================
// Market read — per-asset mark / slot_last / oracle mode
// ============================================================================
interface AssetView { idx: number; mark: bigint; slotLast: bigint; mode: number; lastGood: bigint; }

async function readAssets(): Promise<Map<number, AssetView>> {
  const info = await conn.getAccountInfo(MARKET, "confirmed");
  if (!info) throw new Error("market account missing");
  const buf = Buffer.from(info.data);
  const out = new Map<number, AssetView>();
  for (const idx of Object.keys(ASSET_ORACLE_ACCTS).map(Number)) {
    const slotOff = MARKET_GROUP_OFF + MG.asset_slots + idx * ASSET_SLOT_LEN;
    const a: any = parseAsset(buf, slotOff + ASSET_ORACLE_WRAPPER_LEN, idx);
    const p: any = parseAssetOracleProfile(buf, slotOff, idx);
    out.set(idx, {
      idx, mark: a.effectivePrice as bigint, slotLast: a.slotLast as bigint,
      mode: p.oracleMode as number, lastGood: p.lastGoodOracleSlot as bigint,
    });
  }
  return out;
}

// crank-account tail for an asset: empty when the asset reads no external oracle.
function crankAccts(asset: AssetView): PublicKey[] {
  return readsExternalOracle(asset.mode) ? (ASSET_ORACLE_ACCTS[asset.idx] ?? []) : [];
}

// ============================================================================
// Health classification (off-chain, no tx)
// ============================================================================
type Cls = "HOT" | "WARM" | "COLD" | "IDLE";
interface PosHealth {
  address: PublicKey;
  legs: { assetIndex: number; sizeAbs: bigint }[];
  equity: bigint; maintenance: bigint; bufferRatio: number; markAgeMax: bigint;
}

function classify(buf: PosHealth, curSlot: bigint): Cls {
  if (buf.markAgeMax > FRESH_SLOTS) return buf.bufferRatio < HOT_RATIO ? "HOT" : "WARM";
  if (buf.bufferRatio < HOT_RATIO) return "HOT";
  if (buf.bufferRatio < WARM_RATIO) return "WARM";
  return "COLD";
}

// equity & maintenance for one portfolio at the current stored marks.
function healthOf(row: any, assets: Map<number, AssetView>, curSlot: bigint): PosHealth | null {
  const legs: { assetIndex: number; sizeAbs: bigint }[] = [];
  let maintenance = 0n, markAgeMax = 0n;
  for (const leg of row.data.legs) {
    const sizeAbs = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
    if (sizeAbs === 0n) continue;
    const a = assets.get(leg.assetIndex);
    if (!a) continue; // leg on an asset the keeper doesn't track
    legs.push({ assetIndex: leg.assetIndex, sizeAbs });
    const notional = (sizeAbs * a.mark) / POS_SCALE;
    const reqProp = (notional * MM_BPS) / 10_000n;
    maintenance += reqProp > MIN_MM_REQ ? reqProp : MIN_MM_REQ;
    const age = curSlot - a.slotLast;
    if (age > markAgeMax) markAgeMax = age;
  }
  if (legs.length === 0) return null;
  const feeDebt = row.data.feeCredits < 0n ? -row.data.feeCredits : 0n;
  const equity = (row.data.capital as bigint) + (row.data.pnl as bigint) - feeDebt;
  const slack = equity - maintenance;
  const bufferRatio = maintenance > 0n ? Number(slack) / Number(maintenance) : 0;
  return { address: row.address, legs, equity, maintenance, bufferRatio, markAgeMax };
}

// ============================================================================
// Pyth push (self-maintained m1 legs only, when aging toward staleness)
// ============================================================================
const PUSH_IF_OLDER_SECS = 500;
const SKIP_IF_OLDER_SECS = 750;
async function pushLegsFor(assetIdx: number) {
  if (assetIdx !== 1) return; // only m1 (STOXX/EUR) is self-maintained
  const pusher = NETWORK === "mainnet" ? `${PUSHER_DIR}/push.js` : `${PUSHER_DIR}/push-devnet.js`;
  const nowTs = Math.floor(Date.now() / 1000);
  for (const { feed, acct } of PUSH_LEGS) {
    try {
      const info = await conn.getAccountInfo(acct, "confirmed");
      if (info && info.data.length >= 101) {
        const age = nowTs - Number(info.data.readBigInt64LE(93));
        if (age >= 0 && age < PUSH_IF_OLDER_SECS) continue;
        if (age > SKIP_IF_OLDER_SECS) continue; // after-hours → EWMA fallback
      }
      const r = spawnSync("node", [pusher, feed, "0", KEEPER_KEYPAIR_PATH],
        { cwd: PUSHER_DIR, env: { ...process.env, SOLANA_RPC_URL: RPC }, encoding: "utf8", timeout: 25_000 });
      if (r.status === 0) { pushes++; console.log(`  ✅  push ${feed.slice(0, 12)}…`); }
      else console.log(`  ❌  push ${feed.slice(0, 12)}…: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]}`);
    } catch (e: any) { console.log(`  ❌  push ${feed.slice(0, 12)}…: ${e.message ?? e}`); }
  }
}

// ============================================================================
// Crank (action:0) + Liquidate (action:1)
// ============================================================================
function crankIx(asset: AssetView, slot: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: KEEPER_PORTFOLIO, isSigner: false, isWritable: true },
      ...crankAccts(asset).map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
    ],
    data: encPermissionlessCrank({ action: 0, assetIndex: asset.idx, nowSlot: slot, fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
  });
}
async function crankOnce(asset: AssetView): Promise<void> {
  const slot = BigInt(await conn.getSlot("confirmed"));
  try { await send([crankIx(asset, slot)]); cranksOk++; }
  catch (e: any) {
    const code = errCode(e);
    // 0x16 EngineNonProgress = mark already fresh / no new oracle data → benign no-op
    if (HEALTHY(code)) { cranksOk++; return; }
    cranksFail++; console.log(`  ❌  crank m${asset.idx}: ${code}`);
  }
}

function liquidateIx(target: PublicKey, idx: number, slot: bigint, closeQ: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: target, isSigner: false, isWritable: true },
      { pubkey: keeperWsol, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encPermissionlessCrank({ action: 1, assetIndex: idx, nowSlot: slot, fundingRateE9: 0n, closeQ, feeBps: 0n, recoveryReason: 0 }),
  });
}
// Attempt to liquidate every leg of one portfolio on a given asset.
async function tryLiquidate(target: PublicKey, assetIdx: number, sizeAbs: bigint): Promise<void> {
  const slot = BigInt(await conn.getSlot("confirmed"));
  const closeQ = sizeAbs > (1n << 120n) ? sizeAbs : (1n << 120n); // clamp large; engine caps at real size
  liqAttempt++;
  try {
    await send([liquidateIx(target, assetIdx, slot, closeQ)]);
    liqDone++;
    console.log(`  💥  LIQUIDATED ${target.toBase58()} m${assetIdx} size=${sizeAbs}`);
  } catch (e: any) {
    const code = errCode(e);
    if (HEALTHY(code)) return; // healthy → not liquidatable (norm)
    console.log(`  ⚠️   liq ${target.toBase58().slice(0, 8)}… m${assetIdx}: ${code}`);
  }
}

async function ensureKeeperWsol() {
  try {
    if (await conn.getAccountInfo(keeperWsol, "confirmed")) return;
    await send([
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperWsol, keeper.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: keeperWsol, lamports: Number(WSOL_REWARD_WRAP) }),
      { keys: [{ pubkey: keeperWsol, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) },
    ]);
  } catch (e: any) { console.log(`  ❌  keeper wSOL ATA: ${errCode(e)}`); }
}

// ============================================================================
// Main — proximity classification then tiered action
// ============================================================================
async function main() {
  console.log(`bounty5-v16 proximity tick  network=${NETWORK}  market=${MARKET.toBase58()}`);
  console.log(`  keeper=${keeper.publicKey.toBase58()}  portfolio=${KEEPER_PORTFOLIO.toBase58()}`);

  const assets = await readAssets();
  const curSlot = BigInt(await conn.getSlot("confirmed"));

  // discover foreign positions on THIS market
  let rows: any[] = [];
  try { rows = await discoverPortfolios(conn, PROGRAM_ID); }
  catch (e: any) { console.log(`  ❌  discoverPortfolios: ${errCode(e)}`); }

  const healths: { h: PosHealth; cls: Cls }[] = [];
  for (const row of rows) {
    if (row.address.equals(KEEPER_PORTFOLIO)) continue;
    if (!row.data.marketGroupId.equals(MARKET)) continue;
    const h = healthOf(row, assets, curSlot);
    if (!h) continue;
    healths.push({ h, cls: classify(h, curSlot) });
  }

  // aggregate per-asset class (worst position wins) + remember which positions are live
  const assetCls = new Map<number, Cls>();
  const rank: Record<Cls, number> = { IDLE: 0, COLD: 1, WARM: 2, HOT: 3 };
  for (const { h, cls } of healths) {
    console.log(`  position ${h.address.toBase58().slice(0, 8)}… equity=${h.equity} maint=${h.maintenance} bufferRatio=${h.bufferRatio.toFixed(2)} markAge=${h.markAgeMax} → ${cls}`);
    for (const leg of h.legs) {
      const prev = assetCls.get(leg.assetIndex) ?? "IDLE";
      if (rank[cls] > rank[prev]) assetCls.set(leg.assetIndex, cls);
    }
  }

  await ensureKeeperWsol();

  // ---- act per asset ----
  for (const asset of assets.values()) {
    const cls = assetCls.get(asset.idx) ?? "IDLE";

    if (cls === "COLD") { console.log(`  m${asset.idx} COLD — skip`); continue; }

    if (cls === "IDLE") {
      const age = curSlot - asset.lastGood;
      if (age > HEARTBEAT_SLOTS) {
        console.log(`  m${asset.idx} IDLE heartbeat (oracle age ${age} > ${HEARTBEAT_SLOTS})`);
        await pushLegsFor(asset.idx);
        await crankOnce(asset);
      } else {
        console.log(`  m${asset.idx} IDLE — fresh (oracle age ${age}), skip`);
      }
      continue;
    }

    if (cls === "WARM") {
      console.log(`  m${asset.idx} WARM — refresh + probe`);
      await pushLegsFor(asset.idx);
      await crankOnce(asset);
      for (const { h } of healths) {
        const leg = h.legs.find((l) => l.assetIndex === asset.idx);
        if (leg) await tryLiquidate(h.address, asset.idx, leg.sizeAbs);
      }
      continue;
    }

    // HOT — tight crank+liquidate burst until the asset's positions are gone/healthy
    console.log(`  m${asset.idx} HOT — burst`);
    await pushLegsFor(asset.idx);
    for (let c = 0; c < BURST_CYCLES; c++) {
      const t0 = Date.now();
      const fresh = (await readAssets()).get(asset.idx)!;
      await crankOnce(fresh);
      // re-evaluate positions on this asset against the freshly-walked mark
      let live = 0;
      let upd: any[] = [];
      try { upd = await discoverPortfolios(conn, PROGRAM_ID); } catch { upd = []; }
      const a2 = await readAssets();
      for (const row of upd) {
        if (row.address.equals(KEEPER_PORTFOLIO) || !row.data.marketGroupId.equals(MARKET)) continue;
        const h = healthOf(row, a2, BigInt(await conn.getSlot("confirmed")));
        if (!h) continue;
        const leg = h.legs.find((l) => l.assetIndex === asset.idx);
        if (!leg) continue;
        live++;
        await tryLiquidate(h.address, asset.idx, leg.sizeAbs);
      }
      if (live === 0) { console.log(`  m${asset.idx} burst done (no live positions)`); break; }
      if (c < BURST_CYCLES - 1) {
        const wait = BURST_MS - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  console.log(`\n===== tick done: cranks ok=${cranksOk} fail=${cranksFail}  liq=${liqDone}/${liqAttempt}  pushes=${pushes} =====`);
}

main().catch((e: any) => { console.error("tick error:", e?.message ?? e); process.exit(0); });
