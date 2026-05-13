/**
 * Mainnet bounty 3 cron tick — runs once per minute under cron.
 *
 * Each tick:
 *   1. Reads slab + vault SPL pre-state
 *   2. Submits a permissionless KeeperCrank (caller_idx = u16::MAX)
 *   3. Reads slab + vault SPL post-state
 *   4. Diffs and logs:
 *        - insurance fund delta (≥ 0 expected; any decrease = potential bounty hit)
 *        - cTot delta, vault delta
 *        - numUsedAccounts (new account / closed account events)
 *        - rrCursorPosition + sweepGeneration (sweep liveness)
 *        - lastOraclePrice change (oracle moved)
 *        - sideMode_long / sideMode_short (anything ≠ Normal = liquidation cascade)
 *        - price_move_consumed_bps_this_generation vs threshold
 *        - last_market_slot vs current slot (accrue staleness)
 *   5. Conservation checks: vault SPL == engine.vault, vault >= cTot + insurance.
 *   6. Writes one JSON line to ~/.cache/percolator/bounty3-tick.log per tick.
 *
 * Exit code 0 always — cron should not retry on non-fatal anomalies; the
 * watcher line in the log file is the alert surface. If `INSURANCE_DROP`
 * or `CONSERVATION_BROKEN` flags appear, route those lines to a real
 * alerting channel (PagerDuty, etc.).
 *
 * The tx call is wrapped in `timeout 50` (set in the cron entry) so a
 * hung RPC doesn't pile up child processes the way the v1 mainnet hit.
 */

// Note: do NOT import "dotenv/config" — the repo's .env points at devnet.
// This mainnet tick must NOT pick up a devnet URL from the .env file.
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { ACCOUNTS_KEEPER_CRANK, buildAccountMetas, WELL_KNOWN } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseUsedIndices } from "../src/solana/slab.js";

export type Snapshot = {
  iso: string;
  slot: number;
  marketSlot: bigint;
  marketSlotLag: number;
  numUsed: number;
  vault: bigint;
  cTot: bigint;
  insurance: bigint;
  spl: bigint;
  lastOraclePrice: bigint;
  sideModeLong: number;
  sideModeShort: number;
  rrCursor: bigint;
  sweepGen: bigint;
  priceMoveConsumed: bigint;
  conservationOk: boolean;
  accountingOk: boolean;
};

async function snap(conn: Connection, slab: PublicKey, vault: PublicKey): Promise<Snapshot> {
  const slot = await conn.getSlot("confirmed");
  const buf = await fetchSlab(conn, slab);
  const e = parseEngine(buf);
  const splBal = (await getAccount(conn, vault)).amount;
  return {
    iso: new Date().toISOString(),
    slot,
    marketSlot: e.lastMarketSlot,
    marketSlotLag: slot - Number(e.lastMarketSlot),
    numUsed: parseUsedIndices(buf).length,
    vault: e.vault,
    cTot: e.cTot,
    insurance: e.insuranceFund.balance,
    spl: BigInt(splBal),
    lastOraclePrice: e.lastOraclePrice,
    sideModeLong: e.sideModeLong,
    sideModeShort: e.sideModeShort,
    rrCursor: e.rrCursorPosition,
    sweepGen: e.sweepGeneration,
    priceMoveConsumed: e.stressConsumedBpsE9SinceEnvelope,
    conservationOk: e.vault === BigInt(splBal),
    accountingOk: e.vault >= e.cTot + e.insuranceFund.balance,
  };
}

export function diff(a: Snapshot, b: Snapshot): { flags: string[]; deltas: Record<string, string> } {
  const flags: string[] = [];
  const deltas: Record<string, string> = {};
  if (b.insurance < a.insurance) {
    flags.push("INSURANCE_DROP");
    deltas.insurance = `${a.insurance} → ${b.insurance} (Δ=-${a.insurance - b.insurance})`;
  } else if (b.insurance > a.insurance) {
    deltas.insurance = `+${b.insurance - a.insurance}`;
  }
  if (b.numUsed !== a.numUsed) {
    deltas.numUsed = `${a.numUsed} → ${b.numUsed}`;
    if (b.numUsed > a.numUsed) flags.push("ACCOUNT_OPENED");
    else flags.push("ACCOUNT_CLOSED");
  }
  if (b.cTot !== a.cTot) deltas.cTot = `${a.cTot} → ${b.cTot}`;
  if (b.vault !== a.vault) deltas.vault = `${a.vault} → ${b.vault}`;
  if (b.lastOraclePrice !== a.lastOraclePrice) {
    deltas.lastOraclePrice = `${a.lastOraclePrice} → ${b.lastOraclePrice}`;
  }
  if (b.rrCursor !== a.rrCursor || b.sweepGen !== a.sweepGen) {
    deltas.sweep = `cursor:${a.rrCursor}→${b.rrCursor} gen:${a.sweepGen}→${b.sweepGen}`;
  }
  if (b.sideModeLong !== 0 || b.sideModeShort !== 0) {
    flags.push(`SIDE_MODE_NON_NORMAL(L=${b.sideModeLong},S=${b.sideModeShort})`);
  }
  if (b.priceMoveConsumed > 0n) {
    // Stored as `bps × PRICE_MOVE_CONSUMPTION_SCALE` (SCALE = 1e9), so
    // divide by 1e9 to get bps. Threshold = 80% of im (= 400 bps for our
    // 20x market with im=500 bps) — early warn before the engine flips
    // fresh-PnL admission to slow-path at the spec's 500-bps trigger.
    const SCALE = 1_000_000_000n;
    const bps = b.priceMoveConsumed / SCALE;
    deltas.priceMoveConsumedBps = bps.toString();
    if (bps > 400n) flags.push(`PRICE_MOVE_SAT(consumed=${bps}bps)`);
  }
  if (!b.conservationOk) flags.push("CONSERVATION_BROKEN");
  if (!b.accountingOk) flags.push("ACCOUNTING_BROKEN");
  // Stale-accrue warning: lag should stay near the cron interval (~150 slots).
  // > 600 slots (4 cron intervals missed) → cranker is broken.
  if (b.marketSlotLag > 600) flags.push(`ACCRUE_LAG(${b.marketSlotLag}sl)`);
  return { flags, deltas };
}

function loadHeliusKey(): string | null {
  const p = path.join(os.homedir(), ".helius");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").trim();
}

function pickRpc(): { rpc: string; label: string }[] {
  // Primary: Helius (if key file present). Fallback: public mainnet.
  // The tick script tries primary, then falls back per call on RPC error.
  const out: { rpc: string; label: string }[] = [];
  const key = loadHeliusKey();
  if (key) out.push({ rpc: `https://mainnet.helius-rpc.com/?api-key=${key}`, label: "helius" });
  out.push({ rpc: "https://api.mainnet-beta.solana.com", label: "public" });
  // Allow explicit override via env (skips both — used for tests). Refuse
  // any devnet URL since this tick is mainnet-only.
  if (process.env.SOLANA_RPC_URL && process.env.SOLANA_RPC_URL !== "auto") {
    if (/devnet|testnet/.test(process.env.SOLANA_RPC_URL)) {
      throw new Error(`refusing devnet RPC for mainnet tick: ${process.env.SOLANA_RPC_URL}`);
    }
    return [{ rpc: process.env.SOLANA_RPC_URL, label: "env" }];
  }
  return out;
}

async function main() {
  const cwd = process.env.PERCOLATOR_DIR ?? path.dirname(new URL(import.meta.url).pathname);
  process.chdir(cwd);
  const m = JSON.parse(fs.readFileSync("mainnet-bounty3-market.json", "utf-8"));
  const programId = new PublicKey(m.programId);
  const slab = new PublicKey(m.slab);
  const vault = new PublicKey(m.vault);
  const oracle = new PublicKey(m.oracle);
  // Multi-leg composite oracle (bounty 4+): if the manifest lists additional
  // leg accounts, pass them all to KeeperCrank. The wrapper expects exactly
  // oracle_leg_count Pyth PriceUpdateV2 accounts starting at index 3 (after
  // caller, slab, clock). Missing legs → the crank rejects with
  // "insufficient account keys for instruction" and the market falls behind.
  const oracleLegs: PublicKey[] = [oracle];
  if (m.oracleLeg2) oracleLegs.push(new PublicKey(m.oracleLeg2));
  if (m.oracleLeg3) oracleLegs.push(new PublicKey(m.oracleLeg3));

  const rpcs = pickRpc();
  // Try the first RPC; if it errors out building the connection / reading
  // we'll log the failure and re-attempt with the next one. The crank tx
  // itself is sent via whichever RPC produces a successful pre-snap.
  let conn: Connection | null = null;
  let rpcLabel = "";
  for (const r of rpcs) {
    try {
      const c = new Connection(r.rpc, "confirmed");
      // Cheap health probe: getLatestBlockhash. ~1 ms on Helius, ~50 ms public.
      await c.getLatestBlockhash("processed");
      conn = c;
      rpcLabel = r.label;
      break;
    } catch (_) { /* try next */ }
  }
  if (!conn) throw new Error(`all RPCs failed: ${rpcs.map(r => r.label).join(",")}`);

  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")
  )));

  // Log destination — JSONL, one line per tick, append-only.
  const logDir = path.join(os.homedir(), ".cache", "percolator");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "bounty3-tick.log");
  const log = (obj: any) => fs.appendFileSync(logPath, JSON.stringify(obj) + "\n");

  let pre: Snapshot | undefined;
  try {
    pre = await snap(conn, slab, vault);
  } catch (e: any) {
    log({ iso: new Date().toISOString(), event: "PRE_SNAP_ERR", err: String(e).slice(0, 200) });
    return; // RPC blip — next tick will retry
  }

  // Inner loop. Cron triggers once per minute; the engine's
  // MAX_ACCRUAL_DT_SLOTS=10 means a single crank only advances ~10 slots when
  // OI>0, so a single-shot-per-minute crank cannot keep up with wall-clock
  // (~150 slots/min). Solution: spend the cron minute firing one crank every
  // ROUND_INTERVAL_MS (~4 s, matching 10 slots wall-clock). With backlog,
  // bundle up to nMax cranks per tx to catch up faster.
  const LOOP_DEADLINE_MS = 48_000;          // leave 2s slack inside cron's `timeout 50`
  const ROUND_INTERVAL_MS = 4_000;          // ~10 slots wall-clock per round
  const N_HARD_CAP = 9;                     // CU budget caps bundle size
  const CU_CEILING = 1_400_000;             // Solana per-tx max
  // Priority adapts via exponential backoff on lag growth across cron ticks:
  //   - Start at 1 µLamport/CU (smallest valid >0; lowest possible Solana fee).
  //   - If post-tick lag > start-of-tick lag (we lost ground), 2× priority.
  //   - If lag stable/shrinking, 0.5× priority (floor 1).
  //   - Hard ceiling at 100_000 µLamports/CU (above which the crank is rugged
  //     into competitive territory; recheck cron health first).
  const PRIORITY_FLOOR = 1;
  const PRIORITY_CEIL = 100_000;

  // Empirical per-crank CU cost depends on engine state. From on-chain logs:
  //   - Resolved market:                     ~11K per crank (no-op)
  //   - Live, OI=0:                          ~78K per crank (oracle + tiny accrue)
  //   - Live, OI>0, lag<=MAX_DT (10 slots):  ~78K per crank (single segment)
  //   - Live, OI>0, lag>MAX_DT, 1st crank:  ~430K (sweep + accrue init)
  //   - Live, OI>0, lag>MAX_DT, 2nd crank:  ~400K (more sweep work)
  //   - Live, OI>0, lag>MAX_DT, 3rd+:        ~78K each (steady-state catchup)
  // We size CU at ~1.15× expected with a 60K fixed base for tx-level overhead.
  function estimateCu(n: number, marketMode: number, oiAny: boolean, lag: number): number {
    if (n < 1) n = 1;
    const BASE = 60_000;
    let perCrankCost: number[];
    if (marketMode === 1) {
      // Resolved: every crank is a no-op (~11K). Stay tight.
      perCrankCost = Array(n).fill(15_000);
    } else if (!oiAny || lag <= 10) {
      // Live, no chunked catchup needed
      perCrankCost = Array(n).fill(95_000);
    } else {
      // Live with chunked catchup. First two cranks pay sweep+accrue init.
      perCrankCost = [];
      for (let k = 0; k < n; k++) {
        if (k === 0)      perCrankCost.push(460_000);
        else if (k === 1) perCrankCost.push(420_000);
        else              perCrankCost.push(95_000);
      }
    }
    const sum = perCrankCost.reduce((a, b) => a + b, 0);
    const limit = Math.ceil((BASE + sum) * 1.15);
    return Math.min(CU_CEILING, Math.max(20_000, limit));
  }

  const cuStatePath = path.join(os.homedir(), ".cache", "percolator", "bounty3-cu.json");
  let nMax = N_HARD_CAP;
  let priorityMicroLamports = PRIORITY_FLOOR;
  let lastTickLag = pre.marketSlotLag;  // for backoff comparison
  try {
    const s = JSON.parse(fs.readFileSync(cuStatePath, "utf8"));
    if (typeof s.nMax === "number") {
      nMax = Math.max(1, Math.min(N_HARD_CAP, s.nMax));
    }
    if (typeof s.priorityMicroLamports === "number") {
      priorityMicroLamports = Math.max(PRIORITY_FLOOR,
        Math.min(PRIORITY_CEIL, s.priorityMicroLamports));
    }
    if (typeof s.lastTickLag === "number") {
      lastTickLag = s.lastTickLag;
    }
  } catch { /* first run */ }

  // Apply backoff up-front based on whether the PREVIOUS cron tick made
  // progress (the persisted lastTickLag is its end-of-tick lag).
  if (pre.marketSlotLag > lastTickLag + 50) {       // lost ≥50 slots → escalate
    priorityMicroLamports = Math.min(PRIORITY_CEIL, priorityMicroLamports * 2);
  } else if (pre.marketSlotLag <= lastTickLag) {    // held or improved → decay
    priorityMicroLamports = Math.max(PRIORITY_FLOOR,
      Math.floor(priorityMicroLamports / 2));
  }

  // Per-cron-tick aggregates rolled up into one JSONL line at the end.
  type RoundResult = {
    iso: string;
    lagBefore: number;
    n: number;
    cuLimit: number;
    sig: string | null;
    err: string | null;
    cuConsumed: number | null;
    oom: boolean;
  };
  const rounds: RoundResult[] = [];

  const buildCrankTx = (n: number, cuLimit: number, priorityMicroLamports: number) => {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
    // ACCOUNTS_KEEPER_CRANK spec covers the legacy 4-key layout. For multi-leg
    // markets the wrapper expects oracle_leg_count Pyth accounts starting at
    // index 3, so we append extra read-only metas for leg2/leg3.
    const crankBaseKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab, WELL_KNOWN.clock, oracleLegs[0],
    ]);
    const extraLegMetas = oracleLegs.slice(1).map(pk => ({
      pubkey: pk, isSigner: false, isWritable: false,
    }));
    const crankKeys = [...crankBaseKeys, ...extraLegMetas];
    for (let k = 0; k < n; k++) {
      tx.add(buildIx({
        programId,
        keys: crankKeys,
        data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
      }));
    }
    return tx;
  };

  const start = Date.now();
  let firstLag = pre.marketSlotLag;
  let lastLag = pre.marketSlotLag;

  while (Date.now() - start < LOOP_DEADLINE_MS) {
    const roundStart = Date.now();

    // Read pre-state to size N AND the CU limit. Use "processed" commitment
    // to avoid wasting budget on confirmed-slot lag.
    let lagNow = lastLag;
    let marketMode = 0;  // Live
    let oiAny = true;    // assume OI to be safe
    try {
      const slot = await conn.getSlot("processed");
      const buf = await fetchSlab(conn, slab);
      const eNow = parseEngine(buf);
      lagNow = slot - Number(eNow.lastMarketSlot);
      lastLag = lagNow;
      marketMode = eNow.marketMode;
      const oiL = (eNow as any).oiEffLongQ ?? 0n;
      const oiS = (eNow as any).oiEffShortQ ?? 0n;
      oiAny = (typeof oiL === "bigint" ? oiL : BigInt(oiL)) !== 0n
           || (typeof oiS === "bigint" ? oiS : BigInt(oiS)) !== 0n;
    } catch (_) { /* fall back to last known */ }

    const segmentsNeeded = Math.max(1, Math.ceil(lagNow / 10));
    const n = Math.max(1, Math.min(nMax, segmentsNeeded));
    const cuLimit = estimateCu(n, marketMode, oiAny, lagNow);

    let sig: string | null = null;
    let err: string | null = null;
    let oom = false;  // detected only after end-of-tick from confirmed history

    // Fire-and-forget: do NOT wait for confirmation, so we can keep our 4-sec
    // pacing tight inside the cron's 50-sec window. Signed locally with a
    // fresh blockhash; we read tx outcomes (CU, OOM) at end of tick via
    // signature lookup if needed.
    try {
      const tx = buildCrankTx(n, cuLimit, priorityMicroLamports);
      const { blockhash } = await conn.getLatestBlockhash("processed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true, preflightCommitment: "processed",
      });
    } catch (e: any) {
      err = (e.message || String(e)).split("\n")[0].slice(0, 200);
    }

    rounds.push({
      iso: new Date().toISOString(),
      lagBefore: lagNow,
      n,
      cuLimit,
      sig,  // full sig; truncated only at final summary log
      err: err ? err.slice(0, 120) : null,
      cuConsumed: null,  // not fetched in fire-and-forget mode
      oom,
    });

    // Pace to ~4 s between rounds. If the tx itself took longer, skip the wait.
    const elapsed = Date.now() - roundStart;
    const sleepMs = ROUND_INTERVAL_MS - elapsed;
    if (sleepMs > 0 && Date.now() - start + sleepMs < LOOP_DEADLINE_MS) {
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }

  // End-of-tick OOM check: fetch statuses for fired sigs, count OOMs in logs.
  // Shrink nMax (persisted) when any tx hit "exceeded CUs". No growth path —
  // a successful tick at current nMax is the implicit signal to keep it.
  const sigsToCheck = rounds.filter(r => r.sig).map(r => r.sig!);
  let oomCount = 0;
  if (sigsToCheck.length > 0) {
    try {
      // Sample up to the last 4 sigs to keep RPC cheap.
      const sample = sigsToCheck.slice(-4);
      const full = await conn.getSignatureStatuses(sample, { searchTransactionHistory: false });
      for (let i = 0; i < sample.length; i++) {
        const s = full.value[i];
        if (s?.err) {
          // Pull the full tx to inspect logs.
          try {
            const info = await conn.getTransaction(sample[i], {
              commitment: "confirmed", maxSupportedTransactionVersion: 0,
            });
            const logs = info?.meta?.logMessages?.slice(-3).join("|") ?? "";
            if (logs.includes("exceeded CUs")) { oomCount++; rounds[rounds.length - sample.length + i]!.oom = true; }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  let nextNMax = nMax;
  if (oomCount > 0) {
    nextNMax = Math.max(1, nMax - 3);
  }
  // Always persist (nMax + priority + final lag) so backoff decisions chain
  // across cron ticks.
  try {
    fs.writeFileSync(cuStatePath, JSON.stringify({
      nMax: nextNMax,
      priorityMicroLamports,
      lastTickLag: lastLag,
      lastTickIso: new Date().toISOString(),
    }));
  } catch {}

  // Post-snapshot, then write one summary JSONL line.
  let post: Snapshot | undefined;
  try {
    post = await snap(conn, slab, vault);
  } catch (e: any) {
    log({ iso: new Date().toISOString(), event: "POST_SNAP_ERR", rounds: rounds.length, err: String(e).slice(0, 200) });
    return;
  }

  const { flags, deltas } = diff(pre, post);
  const failed = rounds.filter(r => r.err).length;
  log({
    iso: post.iso,
    slot: post.slot,
    rpc: rpcLabel,
    marketSlotLag: post.marketSlotLag,
    lagBefore: firstLag,
    rounds: rounds.length,
    crankOk: rounds.length - failed,
    crankFail: failed,
    cuSpentLamports: rounds.reduce((s, r) =>
      s + Math.ceil(r.cuLimit * priorityMicroLamports / 1_000_000) + 5_000, 0),
    priorityMicroLamports,
    lastCrank: rounds[rounds.length - 1]?.sig?.slice(0, 16) ?? null,
    lastErr: rounds.findLast?.(r => r.err)?.err ?? null,
    nMax: nextNMax,
    flags,
    deltas,
    state: {
      numUsed: post.numUsed,
      vault: post.vault.toString(),
      cTot: post.cTot.toString(),
      insurance: post.insurance.toString(),
      lastOraclePrice: post.lastOraclePrice.toString(),
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    // Last-ditch: write a single error line and exit 0 so cron doesn't retry.
    const logDir = path.join(os.homedir(), ".cache", "percolator");
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
    try {
      fs.appendFileSync(path.join(logDir, "bounty3-tick.log"),
        JSON.stringify({ iso: new Date().toISOString(), event: "FATAL", err: String(e).slice(0, 300) }) + "\n");
    } catch {}
    process.exit(0);
  });
}
