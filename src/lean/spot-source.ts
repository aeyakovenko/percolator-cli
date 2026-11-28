/**
 * Spot-price sources and the guard that turns raw per-source readings into ONE trusted spot (or none).
 *
 * Sources (independent venues, both reachable from the keeper host):
 *   - Coinbase Exchange ticker  https://api.exchange.coinbase.com/products/BTC-USD/ticker
 *       bid/ask mid + last-trade `time`. (The retail endpoint /v2/prices/BTC-USD/spot is NOT used as the
 *       primary: measured on 2026-11-28 it serves a cached value that flips between replicas and lags the
 *       exchange ticker by 30+ s. It remains available as `coinbaseV2Source` for a fallback slot.)
 *   - Kraken ticker             https://api.kraken.com/0/public/Ticker?pair=XBTUSD
 *       bid/ask mid. No timestamp in the payload: staleness = receipt age + a "stuck value" timer.
 *
 * Guard rules (SpotGuard.evaluate):
 *   1. per reading: finite, inside [minPrice, maxPrice], not older than maxAgeMs (receipt) /
 *      maxSourceAgeMs (venue timestamp), value not frozen for longer than stuckMs.
 *   2. two valid readings: they must agree within agreeBps -> spot = their midpoint (median of two).
 *      Otherwise NO spot ("disagree").
 *   3. one valid reading: usable only while |reading - mark| <= singleSourceMaxGapBps ("single"),
 *      else NO spot ("single-gap").
 *   4. sanity vs the on-chain mark: |spot - mark| > maxMarkGapBps -> NO spot ("mark-gap"; catches a wrong
 *      manifest/units, e.g. a BTC feed pointed at a SOL market).
 *   5. jump sanity: |spot - lastAccepted| > jumpBps needs confirmation by the next evaluation (within
 *      agreeBps of the pending value) before it is accepted ("jump-pending").
 *   6. HOLD (feed outage): when there is no spot, `hold` = the last accepted spot, offered only while
 *      (a) it is younger than maxHoldMs, (b) |mark - lastAccepted| <= holdDriftBps and (c) every
 *      individually-valid reading still visible is within holdDriftBps of it. Otherwise hold = null and
 *      the keeper stops pushing: the oracle goes stale and the AMM fails closed.
 */
import { MAX_PRICE } from "./constants.js";

export interface SourceReading {
  /** price in quote units (USD), float */
  price: number;
  /** venue timestamp of the data (ms), if the venue provides one */
  tsMs: number | null;
  /** when we received it (ms) */
  fetchedMs: number;
}

export interface SpotGuardConfig {
  agreeBps: number;
  singleSourceMaxGapBps: number;
  jumpBps: number;
  maxMarkGapBps: number;
  holdDriftBps: number;
  maxHoldMs: number;
  maxAgeMs: number;
  maxSourceAgeMs: number;
  stuckMs: number;
  minPrice: number;
  maxPrice: number;
}
export const DEFAULT_SPOT_GUARD: SpotGuardConfig = {
  agreeBps: 30,
  singleSourceMaxGapBps: 30,
  jumpBps: 50,
  maxMarkGapBps: 1_500,
  holdDriftBps: 100,
  maxHoldMs: 10 * 60_000,
  maxAgeMs: 10_000,
  maxSourceAgeMs: 60_000,
  stuckMs: 10 * 60_000,
  minPrice: 1,
  maxPrice: Number(MAX_PRICE) / 1e6,
};

export type SpotStatus = "ok" | "single" | "disagree" | "single-gap" | "none" | "jump-pending" | "mark-gap";
export interface SpotVerdict {
  /** trusted spot (E6) or null */
  spot: bigint | null;
  status: SpotStatus;
  /** liveness hold target (E6) when spot is null and the safe-drift bound holds, else null */
  hold: bigint | null;
  /** why hold is null while spot is null (for logs) */
  holdWhy: string;
  /** names of the sources whose reading was valid */
  used: string[];
  /** per-source rejection notes */
  rejected: string[];
  detail: string;
}

const bps = (a: number, b: number) => (Math.abs(a - b) / b) * 1e4;
const toE6 = (p: number) => BigInt(Math.round(p * 1e6));

export class SpotGuard {
  readonly cfg: SpotGuardConfig;
  private lastAccepted: { price: number; atMs: number } | null = null;
  private pending: number | null = null;
  private lastValue = new Map<string, { price: number; sinceMs: number }>();

  constructor(cfg: Partial<SpotGuardConfig> = {}) {
    this.cfg = { ...DEFAULT_SPOT_GUARD, ...cfg };
  }
  get lastGood(): { price: number; atMs: number } | null { return this.lastAccepted; }

  /** Validate one reading in isolation. Returns an error string or null. Updates the stuck-value timer. */
  private check(name: string, r: SourceReading | null, nowMs: number): string | null {
    const c = this.cfg;
    if (r === null) return "down";
    if (typeof r.price !== "number" || !Number.isFinite(r.price)) return "non-finite";
    if (r.price < c.minPrice || r.price > c.maxPrice) return `out-of-range ${r.price}`;
    if (!Number.isFinite(r.fetchedMs) || nowMs - r.fetchedMs > c.maxAgeMs) return `stale receipt ${Math.round((nowMs - r.fetchedMs) / 1000)}s`;
    if (r.tsMs !== null && (!Number.isFinite(r.tsMs) || nowMs - r.tsMs > c.maxSourceAgeMs)) return `stale venue ts ${Math.round((nowMs - (r.tsMs as number)) / 1000)}s`;
    const lv = this.lastValue.get(name);
    if (!lv || lv.price !== r.price) this.lastValue.set(name, { price: r.price, sinceMs: nowMs });
    else if (r.tsMs === null && nowMs - lv.sinceMs > c.stuckMs) return `stuck ${Math.round((nowMs - lv.sinceMs) / 1000)}s`;
    return null;
  }

  evaluate(readings: Record<string, SourceReading | null>, markE6: bigint, nowMs: number): SpotVerdict {
    const c = this.cfg;
    const mark = Number(markE6) / 1e6;
    const valid: { name: string; price: number }[] = [];
    const rejected: string[] = [];
    for (const [name, r] of Object.entries(readings)) {
      const err = this.check(name, r, nowMs);
      if (err === null) valid.push({ name, price: (r as SourceReading).price });
      else rejected.push(`${name}: ${err}`);
    }
    const used = valid.map((v) => v.name);

    let cand: number | null = null;
    let status: SpotStatus = "none";
    let detail = "";
    if (valid.length >= 2) {
      const ps = valid.map((v) => v.price).sort((a, b) => a - b);
      const lo = ps[0], hi = ps[ps.length - 1];
      const spread = bps(hi, lo);
      if (spread <= c.agreeBps) { cand = ps.length % 2 ? ps[ps.length >> 1] : (ps[(ps.length >> 1) - 1] + ps[ps.length >> 1]) / 2; status = "ok"; }
      else { status = "disagree"; detail = `sources differ ${spread.toFixed(1)} bps > ${c.agreeBps} (${valid.map((v) => `${v.name}=${v.price}`).join(" ")})`; }
    } else if (valid.length === 1) {
      const g = bps(valid[0].price, mark);
      if (g <= c.singleSourceMaxGapBps) { cand = valid[0].price; status = "single"; detail = `only ${valid[0].name} is up (gap ${g.toFixed(1)} bps)`; }
      else { status = "single-gap"; detail = `only ${valid[0].name} is up and its gap ${g.toFixed(1)} bps > ${c.singleSourceMaxGapBps}`; }
    } else detail = "no valid source";

    if (cand !== null && bps(cand, mark) > c.maxMarkGapBps) {
      detail = `spot ${cand} is ${bps(cand, mark).toFixed(0)} bps from mark ${mark} > ${c.maxMarkGapBps} (wrong market/units?)`;
      cand = null; status = "mark-gap";
    }
    if (cand !== null && this.lastAccepted !== null && bps(cand, this.lastAccepted.price) > c.jumpBps) {
      if (this.pending !== null && bps(cand, this.pending) <= c.agreeBps) {
        detail = `jump ${bps(cand, this.lastAccepted.price).toFixed(1)} bps confirmed`;
      } else {
        detail = `jump ${bps(cand, this.lastAccepted.price).toFixed(1)} bps vs last accepted ${this.lastAccepted.price} needs confirmation`;
        this.pending = cand; cand = null; status = "jump-pending";
      }
    }
    if (cand !== null) {
      this.pending = null;
      this.lastAccepted = { price: cand, atMs: nowMs };
      return { spot: toE6(cand), status, hold: null, holdWhy: "", used, rejected, detail };
    }
    if (status !== "jump-pending") this.pending = null;

    // ---- no trusted spot: may the keeper hold the oracle alive at the last good spot?
    let hold: bigint | null = null, holdWhy = "";
    const la = this.lastAccepted;
    if (la === null) holdWhy = "no last good spot";
    else if (nowMs - la.atMs > c.maxHoldMs) holdWhy = `last good spot is ${Math.round((nowMs - la.atMs) / 1000)}s old > ${Math.round(c.maxHoldMs / 1000)}s`;
    else if (bps(mark, la.price) > c.holdDriftBps) holdWhy = `mark is ${bps(mark, la.price).toFixed(1)} bps from last good spot > ${c.holdDriftBps}`;
    else {
      const far = valid.find((v) => bps(v.price, la.price) > c.holdDriftBps);
      if (far) holdWhy = `${far.name}=${far.price} is ${bps(far.price, la.price).toFixed(1)} bps from last good spot > ${c.holdDriftBps}`;
      else hold = toE6(la.price);
    }
    return { spot: null, status, hold, holdWhy, used, rejected, detail };
  }
}

// ---------------------------------------------------------------- payload parsers (pure)
const num = (x: unknown): number => (typeof x === "string" || typeof x === "number" ? Number(x) : NaN);
/** bid/ask -> mid, rejecting crossed or absurdly wide books */
function mid(bid: number, ask: number, what: string): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) throw new Error(`${what}: bad bid/ask`);
  if (ask < bid) throw new Error(`${what}: crossed book ${bid}/${ask}`);
  if (((ask - bid) / bid) * 1e4 > 20) throw new Error(`${what}: book wider than 20 bps ${bid}/${ask}`);
  return (bid + ask) / 2;
}
/** Coinbase Exchange `GET /products/<id>/ticker` */
export function parseCoinbaseTicker(j: any, fetchedMs: number): SourceReading {
  const ts = Date.parse(String(j?.time ?? ""));
  if (!Number.isFinite(ts)) throw new Error("coinbase: missing time");
  return { price: mid(num(j?.bid), num(j?.ask), "coinbase"), tsMs: ts, fetchedMs };
}
/** Coinbase retail `GET /v2/prices/<pair>/spot` (cached, no timestamp — fallback only) */
export function parseCoinbaseV2Spot(j: any, fetchedMs: number): SourceReading {
  const p = num(j?.data?.amount);
  if (!Number.isFinite(p) || p <= 0) throw new Error("coinbase-v2: bad amount");
  return { price: p, tsMs: null, fetchedMs };
}
/** Kraken `GET /0/public/Ticker?pair=...` (first pair in the result) */
export function parseKrakenTicker(j: any, fetchedMs: number): SourceReading {
  if (Array.isArray(j?.error) && j.error.length) throw new Error(`kraken: ${String(j.error[0]).slice(0, 60)}`);
  const t: any = j?.result ? Object.values(j.result)[0] : undefined;
  if (!t) throw new Error("kraken: empty result");
  return { price: mid(num(t?.b?.[0]), num(t?.a?.[0]), "kraken"), tsMs: null, fetchedMs };
}

// ---------------------------------------------------------------- sources (I/O) with exponential backoff
export interface SpotSource {
  readonly name: string;
  /** never throws: null = down / backing off */
  read(nowMs: number): Promise<SourceReading | null>;
}
export interface BackoffOptions { baseMs?: number; maxMs?: number; minFetchMs?: number; onError?: (name: string, err: string, retryInMs: number) => void }

/** Wrap a raw fetcher: never throws, exponential backoff on errors, and at most one fetch per minFetchMs. */
export function backoffSource(name: string, fetcher: (nowMs: number) => Promise<SourceReading>, o: BackoffOptions = {}): SpotSource {
  const baseMs = o.baseMs ?? 1_000, maxMs = o.maxMs ?? 60_000, minFetchMs = o.minFetchMs ?? 0;
  let fails = 0, nextTryMs = 0;
  let last: SourceReading | null = null;
  return {
    name,
    async read(nowMs: number) {
      if (nowMs < nextTryMs) return null;
      if (last !== null && nowMs - last.fetchedMs < minFetchMs) return last;
      try {
        last = await fetcher(nowMs);
        fails = 0;
        return last;
      } catch (e) {
        last = null;
        const wait = Math.min(maxMs, baseMs * 2 ** Math.min(fails, 20));
        fails++;
        nextTryMs = nowMs + wait;
        o.onError?.(name, String((e as Error)?.message ?? e).slice(0, 120), wait);
        return null;
      }
    },
  };
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "quote-keeper/1.0", Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export const COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
export const COINBASE_V2_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
export const KRAKEN_TICKER_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";

export const coinbaseSource = (o: BackoffOptions & { url?: string; timeoutMs?: number } = {}): SpotSource =>
  backoffSource("coinbase", async () => parseCoinbaseTicker(await getJson(o.url ?? COINBASE_TICKER_URL, o.timeoutMs ?? 4_000), Date.now()), o);
export const coinbaseV2Source = (o: BackoffOptions & { url?: string; timeoutMs?: number } = {}): SpotSource =>
  backoffSource("coinbase-v2", async () => parseCoinbaseV2Spot(await getJson(o.url ?? COINBASE_V2_SPOT_URL, o.timeoutMs ?? 4_000), Date.now()), o);
export const krakenSource = (o: BackoffOptions & { url?: string; timeoutMs?: number } = {}): SpotSource =>
  backoffSource("kraken", async () => parseKrakenTicker(await getJson(o.url ?? KRAKEN_TICKER_URL, o.timeoutMs ?? 4_000), Date.now()), o);
