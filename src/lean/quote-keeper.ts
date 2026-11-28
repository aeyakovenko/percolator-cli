/**
 * Quote keeper loop: keeps an operator-pushed percolator-lean oracle close to spot WITHOUT pointless pushes,
 * and keeps it from going stale.
 *
 *   every tick:  read all spot sources (off-chain, free)  ->  SpotGuard (agreement / sanity / hold)
 *                read the Market in ONE getAccountInfo (mark, maxMoveBps, lastOracleSlot, maxStaleness + context slot)
 *                decidePush (pure, ./quote-trigger.ts)    ->  at most one UpdateOracle
 *
 * The loop never throws: RPC / feed / transaction errors are logged (secrets masked) and retried next tick.
 * It never decides while a send is in flight (ticks are sequential) and always re-reads the Market after a push.
 * `live: false` (dry run) sends nothing; pushes are simulated on a shadow mark so the counts are meaningful.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { parseMarket, type Market } from "./parsers.js";
import { updateOracle } from "./instructions.js";
import { maxAllowedMove, stampsRampPending } from "./oracle-clamp.js";
import {
  decidePush, gapBpsOf, alarmAgeSlots, type Decision,
  DEFAULT_THRESHOLD_BPS, DEFAULT_MIN_INTERVAL_MS, DEFAULT_POLL_MS, DEFAULT_MAX_PUSHES_PER_HOUR, DEFAULT_HEARTBEAT_FRACTION,
} from "./quote-trigger.js";
import { SpotGuard, type SpotGuardConfig, type SpotSource, type SourceReading, type SpotVerdict } from "./spot-source.js";

/** Strip RPC api keys from anything that is logged (web3.js errors embed the endpoint URL). */
export function maskSecrets(s: unknown): string {
  return String(s).replace(/api-key=[^&\s"')]+/gi, "api-key=***");
}

export interface QuoteKeeperConfig {
  thresholdBps: number;
  pollMs: number;
  /** poll interval while a multi-step move is in progress / waiting for the next slot */
  fastPollMs: number;
  minIntervalMs: number;
  maxPushesPerHour: number;
  heartbeatFraction: number;
  /** stats line interval */
  statsMs: number;
  /** give up waiting for a push to confirm after this long (the next tick re-reads the market) */
  confirmTimeoutMs: number;
  /** per-RPC-call timeout */
  rpcTimeoutMs: number;
  /** health code 3 ("blind") when the Market has not been read successfully for this long */
  blindMs: number;
  live: boolean;
  guard: Partial<SpotGuardConfig>;
}
export const DEFAULT_KEEPER_CONFIG: QuoteKeeperConfig = {
  thresholdBps: DEFAULT_THRESHOLD_BPS,
  pollMs: DEFAULT_POLL_MS,
  fastPollMs: 400,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  maxPushesPerHour: DEFAULT_MAX_PUSHES_PER_HOUR,
  heartbeatFraction: DEFAULT_HEARTBEAT_FRACTION,
  statsMs: 5 * 60_000,
  confirmTimeoutMs: 8_000,
  rpcTimeoutMs: 4_000,
  blindMs: 10_000,
  live: false,
  guard: {},
};

export interface PushEvent {
  atMs: number; reason: string; mark: bigint; price: bigint; spot: bigint | null; gapBps: number;
  ageSlots: bigint; maxAllowed: bigint; diff: bigint; stampsRamp: boolean; sig: string | null; slot: number | null; dry: boolean;
}
/** 0 = ok, 1 = oracle age above 0.8 x maxStaleness (AMM about to be unavailable), 2 = oracle stale (AMM unavailable),
 *  3 = blind: the keeper has not managed to read the Market for `blindMs` (RPC down) and cannot know or fix the age */
export type HealthCode = 0 | 1 | 2 | 3;
export interface TickResult {
  kind: "push" | "skip" | "idle" | "error";
  reason: string;
  /** re-tick after fastPollMs instead of pollMs */
  soon: boolean;
  event?: PushEvent;
  ageSlots?: bigint;
  spotStatus?: string;
}
export interface KeeperStats {
  pushesTotal: number; pushesToday: number; byReason: Record<string, number>; sendFailures: number;
  maxGapBps: number; maxAgeSlots: bigint; maxAgeFraction: number; unavailableMs: number; alarmTicks: number;
  spotRejects: Record<string, number>; lastPushMs: number | null; brakeHits: number; ticks: number;
}

export interface QuoteKeeperOptions {
  conn: Connection;
  programId: PublicKey;
  market: PublicKey;
  /** oracle authority keypair (may be null only in dry mode) */
  oracle: Keypair | null;
  /** fee payer (may be null only in dry mode). Pass the ORACLE keypair itself to pay 1 signature (5000 lamports) instead of 2 (10000). */
  funder: Keypair | null;
  sources: SpotSource[];
  config?: Partial<QuoteKeeperConfig>;
  log?: (line: string) => void;
  now?: () => number;
}

/** Compute-unit limit for a push (UpdateOracle measured ~1.1k CU on devnet 887ba02); the low digits carry a uniqueness nonce. */
export const PUSH_CU_LIMIT = 40_000;

/** Bound an RPC call: ticks are sequential, so one hung request must never outlast the staleness window. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const usd = (n: bigint) => (Number(n) / 1e6).toFixed(2);

export class QuoteKeeper {
  readonly cfg: QuoteKeeperConfig;
  readonly guard: SpotGuard;
  readonly events: PushEvent[] = [];
  readonly stats: KeeperStats = {
    pushesTotal: 0, pushesToday: 0, byReason: {}, sendFailures: 0, maxGapBps: 0, maxAgeSlots: 0n, maxAgeFraction: 0,
    unavailableMs: 0, alarmTicks: 0, spotRejects: {}, lastPushMs: null, brakeHits: 0, ticks: 0,
  };
  private readonly o: QuoteKeeperOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private catchUp = false;
  private pushTimes: number[] = [];
  private day = "";
  private lastStatsMs = 0;
  private lastTickMs: number | null = null;
  private lastSpotStatus = "";
  private lastMarketStatus = "";
  private lastSkipNote = "";
  private braking = false;
  private healthCode: HealthCode = 0;
  private worstHealth: HealthCode = 0;
  private shadow: { mark: bigint; slot: bigint; baseMark: bigint; baseSlot: bigint } | null = null;
  private pending: { sig: string; sentSlot: bigint; ev: PushEvent; capped: boolean } | null = null;
  private nonce = Math.floor(Math.random() * 10_000);
  private periodMaxGap = 0;
  private lastAlarmLogMs = 0;
  private lastReadOkMs = 0;
  private blindLogged = false;

  constructor(o: QuoteKeeperOptions) {
    this.o = o;
    this.cfg = { ...DEFAULT_KEEPER_CONFIG, ...(o.config ?? {}) };
    if (this.cfg.live && (!o.oracle || !o.funder)) throw new Error("QuoteKeeper: live mode needs the oracle and funder keypairs");
    this.guard = new SpotGuard(this.cfg.guard);
    this.now = o.now ?? Date.now;
    this.log = (l) => (o.log ?? console.log)(maskSecrets(l));
    this.lastStatsMs = this.now();
    this.lastReadOkMs = this.now();
  }

  /** current health code and the worst one seen since start */
  health(): { code: HealthCode; worst: HealthCode; unavailableSec: number } {
    const blind = this.now() - this.lastReadOkMs > this.cfg.blindMs;
    if (blind && !this.blindLogged) { this.blindLogged = true; this.worstHealth = 3; this.log(`ALARM BLIND: no successful Market read for ${Math.round((this.now() - this.lastReadOkMs) / 1000)}s (RPC down?) — the oracle may be going stale unseen`); }
    if (!blind && this.blindLogged) { this.blindLogged = false; this.log("market reads are working again"); }
    return { code: blind ? 3 : this.healthCode, worst: this.worstHealth, unavailableSec: Math.round(this.stats.unavailableMs / 1000) };
  }

  private bump(rec: Record<string, number>, k: string) { rec[k] = (rec[k] ?? 0) + 1; }

  private recordPush(ev: PushEvent, capped: boolean) {
    const s = this.stats;
    this.events.push(ev);
    s.pushesTotal++; s.pushesToday++; this.bump(s.byReason, ev.reason);
    s.lastPushMs = ev.atMs;
    // the hourly brake budgets PRICE pushes only: liveness heartbeats are mandatory and, on a short-staleness market,
    // far more frequent than any sane brake (0.4 x 150 slots = one every ~13 s)
    if (ev.reason !== "liveness" && ev.reason !== "liveness-hold") this.pushTimes.push(ev.atMs);
    this.catchUp = capped;
    const g = Number.isNaN(ev.gapBps) ? "n/a" : ev.gapBps.toFixed(2);
    this.log(`${ev.dry ? "DRY " : ""}push ${usd(ev.mark)}->${usd(ev.price)} gap ${g} bps reason ${ev.reason} age ${ev.ageSlots} step ${ev.diff}/${ev.maxAllowed}${ev.stampsRamp ? " RAMP" : ""}${capped ? " (capped, more to come)" : ""}${ev.sig ? ` ${ev.sig.slice(0, 12)}…` : ""}`);
  }

  /** Send one UpdateOracle and wait (bounded) for confirmation. Returns the landing slot, or null on timeout. */
  private async send(price: bigint): Promise<{ sig: string; slot: number | null }> {
    const { conn, programId, market } = this.o;
    const oracle = this.o.oracle!, funder = this.o.funder!;
    const t0 = this.now();
    // A fresh blockhash per push AND a per-push compute-unit limit used as a nonce: two liveness pushes of the SAME price
    // would otherwise be byte-identical transactions ("This transaction has already been processed").
    const rt = this.cfg.rpcTimeoutMs;
    const { blockhash } = await withTimeout(conn.getLatestBlockhash("confirmed"), rt, "getLatestBlockhash");
    this.nonce = (this.nonce + 1) % 10_000;
    const tx = new Transaction({ feePayer: funder.publicKey, recentBlockhash: blockhash })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: PUSH_CU_LIMIT + this.nonce }))
      .add(updateOracle(programId, { market, oracleAuth: oracle.publicKey, price }));
    if (funder.publicKey.equals(oracle.publicKey)) tx.sign(oracle); else tx.sign(funder, oracle); // oracle-as-payer = 1 signature = 5000 lamports
    const raw = tx.serialize();
    const sig = await withTimeout(conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 0 }), rt, "sendTransaction");
    let lastResend = this.now();
    while (this.now() - t0 < this.cfg.confirmTimeoutMs) {
      await sleep(350);
      const st = (await withTimeout(conn.getSignatureStatuses([sig]), rt, "getSignatureStatuses").catch(() => null))?.value[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { sig, slot: st.slot };
      if (this.now() - lastResend > 2_000) {
        lastResend = this.now();
        await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
      }
    }
    return { sig, slot: null };
  }

  private statsLine(nowMs: number, m: Market | null, age: bigint | null) {
    const s = this.stats;
    const since = s.lastPushMs === null ? "never" : `${Math.round((nowMs - s.lastPushMs) / 1000)}s`;
    this.log(`heartbeat: pushes today ${s.pushesToday} (total ${s.pushesTotal} ${JSON.stringify(s.byReason)}), price pushes last hour ${this.pushTimes.length}/${this.cfg.maxPushesPerHour}, ` +
      `max gap ${this.periodMaxGap.toFixed(2)} bps (all-time ${s.maxGapBps.toFixed(2)}), last push ${since} ago, ` +
      `oracle age ${age ?? "?"}/${m?.maxStaleness ?? "?"} (max seen ${(s.maxAgeFraction * 100).toFixed(0)}%), AMM unavailable ${Math.round(s.unavailableMs / 1000)}s, ` +
      `send failures ${s.sendFailures}, spot ${this.lastSpotStatus || "?"} rejects ${JSON.stringify(s.spotRejects)}, health ${this.healthCode}${this.cfg.live ? "" : " [DRY]"}`);
    this.periodMaxGap = 0;
  }

  /** One full cycle. Never throws. */
  async tick(): Promise<TickResult> {
    try {
      return await this.tickInner();
    } catch (e) {
      this.log(`ERROR tick: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      this.health(); // raises the BLIND alarm once reads have been failing for blindMs
      return { kind: "error", reason: "exception", soon: false };
    }
  }

  private async tickInner(): Promise<TickResult> {
    const { conn, market } = this.o;
    const s = this.stats;
    const nowMs = this.now();
    s.ticks++;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; s.pushesToday = 0; }
    while (this.pushTimes.length && nowMs - this.pushTimes[0] >= 3_600_000) this.pushTimes.shift();

    // spot sources and the market read run concurrently (sources never throw)
    const names = this.o.sources.map((x) => x.name);
    const [reads, acc] = await Promise.all([
      Promise.all(this.o.sources.map((x) => x.read(nowMs).catch(() => null))),
      withTimeout(conn.getAccountInfoAndContext(market, "confirmed"), this.cfg.rpcTimeoutMs, "getAccountInfo"),
    ]);
    this.lastReadOkMs = nowMs;
    if (!acc.value) { this.log(`ERROR market account ${market.toBase58()} not found`); return { kind: "error", reason: "no-market", soon: false }; }
    const m = parseMarket(Buffer.from(acc.value.data));
    const slot = BigInt(acc.context.slot);
    const elapsed = this.lastTickMs === null ? 0 : nowMs - this.lastTickMs;
    this.lastTickMs = nowMs;

    if (m.statusName !== "Active") {
      if (this.lastMarketStatus !== m.statusName) this.log(`market is ${m.statusName}: not pushing (the oracle only accepts updates while Active)`);
      this.lastMarketStatus = m.statusName;
      this.healthCode = 0;
      if (nowMs - this.lastStatsMs >= this.cfg.statsMs) { this.lastStatsMs = nowMs; this.statsLine(nowMs, m, null); }
      return { kind: "idle", reason: m.statusName, soon: false };
    }
    if (this.lastMarketStatus && this.lastMarketStatus !== "Active") this.log("market is Active again");
    this.lastMarketStatus = "Active";
    if (this.o.oracle && !m.oracleAuth.equals(this.o.oracle.publicKey)) {
      const note = `oracle key ${this.o.oracle.publicKey.toBase58()} is not the market's oracle authority ${m.oracleAuth.toBase58()}`;
      if (this.lastSkipNote !== note) this.log(`ERROR ${note}: not pushing`);
      this.lastSkipNote = note;
      return { kind: "error", reason: "wrong-oracle-key", soon: false };
    }

    // a push whose confirmation timed out: did it land after all?
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      if (m.lastOracleSlot > p.sentSlot && m.markPrice === p.ev.price) {
        this.recordPush({ ...p.ev, slot: Number(m.lastOracleSlot) }, p.capped);
        this.log(`(previous push ${p.sig.slice(0, 12)}… landed late at slot ${m.lastOracleSlot})`);
      }
    }

    // dry mode: overlay the simulated pushes for as long as the chain has not moved underneath
    let mark = m.markPrice, lastOracleSlot = m.lastOracleSlot;
    if (this.shadow) {
      if (this.shadow.baseMark === m.markPrice && this.shadow.baseSlot === m.lastOracleSlot) { mark = this.shadow.mark; lastOracleSlot = this.shadow.slot; }
      else this.shadow = null;
    }

    // ---- availability / health (on the REAL on-chain age in live mode)
    const age = slot > lastOracleSlot ? slot - lastOracleSlot : 0n;          // what the trigger sees (shadow in dry mode)
    const realAge = slot > m.lastOracleSlot ? slot - m.lastOracleSlot : 0n;  // what the chain sees
    const frac = m.maxStaleness > 0n ? Number(realAge) / Number(m.maxStaleness) : 0;
    if (realAge > s.maxAgeSlots) s.maxAgeSlots = realAge;
    if (frac > s.maxAgeFraction) s.maxAgeFraction = frac;
    let code: HealthCode = 0;
    if (realAge > m.maxStaleness) { code = 2; s.unavailableMs += elapsed; }
    else if (realAge > alarmAgeSlots(m.maxStaleness)) code = 1;
    if (code > 0) {
      s.alarmTicks++;
      if (code !== this.healthCode || nowMs - this.lastAlarmLogMs >= 30_000) {
        this.lastAlarmLogMs = nowMs;
        this.log(code === 2
          ? `ALARM AMM UNAVAILABLE: oracle is STALE (age ${realAge} > maxStaleness ${m.maxStaleness}); trading reverts with oracleStale and anyone can StartWindDown. Unavailable ${Math.round(s.unavailableMs / 1000)}s so far`
          : `ALARM oracle age ${realAge} > 0.8 x maxStaleness ${m.maxStaleness}: the AMM is about to become unavailable`);
      }
    } else if (this.healthCode > 0) this.log(`health back to OK (oracle age ${realAge}/${m.maxStaleness})`);
    this.healthCode = code;
    if (code > this.worstHealth) this.worstHealth = code;

    // ---- spot
    const readings: Record<string, SourceReading | null> = {};
    names.forEach((n, i) => { readings[n] = reads[i]; });
    const v: SpotVerdict = this.guard.evaluate(readings, mark, nowMs);
    if (v.status !== "ok") this.bump(s.spotRejects, v.status);
    const spotNote = `${v.status}${v.spot === null ? (v.hold !== null ? "+hold" : "+nohold") : ""}`;
    if (spotNote !== this.lastSpotStatus) {
      if (v.status === "ok") { if (this.lastSpotStatus) this.log(`spot OK again (${v.used.join("+")})`); }
      else this.log(`WARNING spot ${v.status.toUpperCase()}: ${v.detail}${v.rejected.length ? ` [${v.rejected.join("; ")}]` : ""}` +
        (v.spot === null ? (v.hold !== null ? ` -> no price pushes; liveness holds at last good spot ${usd(v.hold)}` : ` -> NOT pushing at all (${v.holdWhy}); the oracle will go stale = AMM fails closed`) : " -> single-source mode"));
      this.lastSpotStatus = spotNote;
    }
    if (v.spot !== null) {
      const g = gapBpsOf(v.spot, mark, mark);
      if (g > s.maxGapBps) s.maxGapBps = g;
      if (g > this.periodMaxGap) this.periodMaxGap = g;
    }

    // ---- brake
    const brake = this.pushTimes.length >= this.cfg.maxPushesPerHour;
    if (brake && !this.braking) { s.brakeHits++; this.log(`ALARM BRAKE: ${this.pushTimes.length} price pushes in the last hour >= MAX_PUSHES_PER_HOUR ${this.cfg.maxPushesPerHour}; only liveness pushes until the window clears`); }
    if (!brake && this.braking) this.log("brake released");
    this.braking = brake;

    const d: Decision = decidePush({
      mark, spot: v.spot, maxMoveBps: m.maxMoveBps, thresholdBps: this.cfg.thresholdBps,
      lastOracleSlot, currentSlot: slot, maxStalenessSlots: m.maxStaleness,
      nowMs, lastPushMs: s.lastPushMs, minIntervalMs: this.cfg.minIntervalMs, heartbeatFraction: this.cfg.heartbeatFraction,
      catchUp: this.catchUp, brake, holdTarget: v.hold,
    });
    if (nowMs - this.lastStatsMs >= this.cfg.statsMs) { this.lastStatsMs = nowMs; this.statsLine(nowMs, m, realAge); }
    if (d.push === null) {
      if (d.reason === "within-threshold" || d.reason === "no-spot") this.catchUp = false;
      return { kind: "skip", reason: d.reason, soon: d.soon, ageSlots: age, spotStatus: v.status };
    }

    const dt = age < 2n ? 1n : age;
    const maxAllowed = maxAllowedMove(mark, m.maxMoveBps, dt);
    const diff = d.push >= mark ? d.push - mark : mark - d.push;
    const ev: PushEvent = {
      atMs: nowMs, reason: d.reason, mark, price: d.push, spot: v.spot, gapBps: d.gapBps, ageSlots: age,
      maxAllowed, diff, stampsRamp: stampsRampPending(maxAllowed, diff), sig: null, slot: null, dry: !this.cfg.live,
    };
    if (!this.cfg.live) {
      this.shadow = { mark: d.push, slot, baseMark: m.markPrice, baseSlot: m.lastOracleSlot };
      this.recordPush(ev, d.capped);
      return { kind: "push", reason: d.reason, soon: d.soon, event: ev, ageSlots: age, spotStatus: v.status };
    }
    try {
      const r = await this.send(d.push);
      if (r.slot === null) {
        this.pending = { sig: r.sig, sentSlot: slot, ev: { ...ev, sig: r.sig }, capped: d.capped };
        s.sendFailures++;
        this.log(`WARNING push ${r.sig.slice(0, 12)}… not confirmed within ${this.cfg.confirmTimeoutMs} ms; re-reading the market`);
        return { kind: "error", reason: "confirm-timeout", soon: true, ageSlots: age };
      }
      ev.sig = r.sig; ev.slot = r.slot; ev.atMs = this.now();
      this.recordPush(ev, d.capped);
      return { kind: "push", reason: d.reason, soon: d.soon, event: ev, ageSlots: age, spotStatus: v.status };
    } catch (e) {
      s.sendFailures++;
      const msg = String((e as Error)?.message ?? e);
      // oracleSameSlot (126 = 0x7e) / oracleClamp (104 = 0x68): benign races (another push or a trade landed in between)
      const benign = /0x7e\b|"Custom":126\b|0x68\b|"Custom":104\b/.test(msg);
      this.log(`${benign ? "note" : "ERROR"} push ${usd(mark)}->${usd(d.push)} (${d.reason}) failed${benign ? " (benign race, retrying)" : ""}: ${msg.slice(0, 220)}`);
      return { kind: "error", reason: benign ? "race" : "send-failed", soon: benign, ageSlots: age };
    }
  }

  /** Run until `signal` aborts. */
  async run(signal: AbortSignal, afterTick?: (r: TickResult) => void): Promise<void> {
    const c = this.cfg;
    this.log(`quote keeper started: market ${this.o.market.toBase58()} threshold ${c.thresholdBps} bps, poll ${c.pollMs} ms, min interval ${c.minIntervalMs} ms, ` +
      `heartbeat at ${(c.heartbeatFraction * 100).toFixed(0)}% of maxStaleness, max ${c.maxPushesPerHour} pushes/h, sources ${this.o.sources.map((x) => x.name).join("+")}, ${c.live ? "LIVE" : "DRY RUN (no transactions)"}`);
    let errStreak = 0;
    while (!signal.aborted) {
      const r = await this.tick();
      try { afterTick?.(r); } catch { /* observer errors never stop the loop */ }
      errStreak = r.kind === "error" && !r.soon ? errStreak + 1 : 0;
      // transient RPC errors: back off up to 4 polls, never longer (liveness matters more than politeness)
      const wait = r.soon ? c.fastPollMs : c.pollMs * Math.min(4, 1 + errStreak * 0.5);
      await new Promise<void>((res) => {
        const t = setTimeout(done, wait);
        function done() { clearTimeout(t); signal.removeEventListener("abort", done); res(); }
        signal.addEventListener("abort", done, { once: true });
      });
    }
    this.statsLine(this.now(), null, null);
    this.log("quote keeper stopped");
  }
}
