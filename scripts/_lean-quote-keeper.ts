/** Price-watching oracle QUOTE KEEPER (long-running). Polls BTC spot off-chain every ~2 s (Coinbase Exchange +
 *  Kraken, cross-checked) and pushes the operator oracle (UpdateOracle) only when needed:
 *    - |spot - mark| >= THRESHOLD_BPS (snap to spot; ramp-free capped steps, back to back for big moves), or
 *    - liveness: oracle age >= HEARTBEAT_FRACTION x maxStaleness (so the AMM never goes stale while we are healthy).
 *  Logic lives in src/lean/{quote-trigger,spot-source,quote-keeper}.ts; this file is config, lock, signals.
 *
 *  Usage:  npx tsx scripts/_lean-quote-keeper.ts [--dry | --live] [--spot-file <json>]      (default --dry: no transactions)
 *          npx tsx scripts/_lean-quote-keeper.ts --health     exit 0 ok / 1 age > 0.8 x maxStaleness / 2 oracle stale / 3 keeper blind (RPC down) or not reporting
 *  Env:    LEAN_MANIFEST (default ~/percolator-cli/lean-mainnet-r4.json: fields market, percolator, oracleAuth)
 *          ORACLE_KEYPAIR (default ~/.config/solana/lean-mainnet-r4-oracle.json), FUNDER_KEYPAIR (default ~/.config/solana/id.json)
 *          FEE_PAYER=oracle  -> the oracle key pays its own fee: 1 signature = 5000 lamports/push instead of 2 = 10000 (fund it first)
 *          LEAN_RPC_URL (default mainnet Helius, key read from ~/.helius; never printed)
 *          THRESHOLD_BPS=10 POLL_MS=2000 MIN_INTERVAL_MS=10000 MAX_PUSHES_PER_HOUR=120 HEARTBEAT_FRACTION=0.4 STATS_MS=300000
 *          AGREE_BPS=30 SINGLE_SOURCE_MAX_GAP_BPS=30 JUMP_BPS=50 MAX_MARK_GAP_BPS=1500 HOLD_DRIFT_BPS=100 MAX_HOLD_MS=600000
 *          HALF_SPREAD_BPS (optional: warns when the threshold is above 0.75 x the AMM half-spread)
 *          LOCK_FILE, HEALTH_FILE (default $TMPDIR/lean-quote-keeper-<market>.{lock,health.json})
 *  --spot-file: TEST HOOK. Replaces the real sources with a JSON file {"coinbase": 59500.1, "kraken": null, ...} re-read
 *          every poll. Refused with --live unless the RPC is devnet. */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  QuoteKeeper, maskSecrets, coinbaseSource, krakenSource, backoffSource, assertDevnet,
  DEFAULT_KEEPER_CONFIG, DEFAULT_SPOT_GUARD, type SpotSource,
} from "../src/lean/index.js";

const HOME = process.env.HOME ?? os.homedir();
const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const argOf = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const ts = () => new Date().toISOString();
const log = (l: string) => console.log(`${ts()} ${maskSecrets(l)}`);
function envNum(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}], got "${raw}"`);
  return v;
}
const loadKp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

// ---------------------------------------------------------------- single-instance lock (O_EXCL + stale-pid detection)
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  // pid exists; guard against pid reuse where /proc is available: the holder must look like a keeper process
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("quote-keeper"); } catch { return true; }
}
export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = NaN;
      try { holder = Number(fs.readFileSync(file, "utf8").trim()); } catch { continue; } // vanished between open and read: retry
      if (pidAlive(holder)) throw new Error(`another quote keeper is running (pid ${holder}, lock ${file})`);
      log(`removing stale lock ${file} (pid ${holder} is gone)`);
      try { fs.unlinkSync(file); } catch { /* raced with another starter: the O_EXCL retry decides */ }
    }
  }
  throw new Error(`could not acquire lock ${file}`);
}

async function main() {
  const maniPath = process.env.LEAN_MANIFEST ?? `${HOME}/percolator-cli/lean-mainnet-r4.json`;
  const mani = JSON.parse(fs.readFileSync(maniPath, "utf8"));
  const market = new PublicKey(mani.market);
  const programId = new PublicKey(mani.percolator);
  const base = path.join(os.tmpdir(), `lean-quote-keeper-${market.toBase58()}`);
  const lockFile = process.env.LOCK_FILE ?? `${base}.lock`;
  const healthFile = process.env.HEALTH_FILE ?? `${base}.health.json`;

  if (flag("--health")) {
    let code = 3, note = "no health file";
    try {
      const h = JSON.parse(fs.readFileSync(healthFile, "utf8"));
      const ageMs = Date.now() - Number(h.updatedMs);
      if (ageMs <= 30_000) { code = Number(h.code) || 0; note = JSON.stringify(h); } else note = `health file is ${Math.round(ageMs / 1000)}s old (daemon not running?)`;
    } catch { /* missing/corrupt -> 3 */ }
    console.log(`health ${code}: ${note}`);
    process.exit(code);
  }

  const live = flag("--live");
  if (live && flag("--dry")) throw new Error("pass either --dry or --live");
  const rpc = process.env.LEAN_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
  const conn = new Connection(rpc, "confirmed");

  const oraclePath = process.env.ORACLE_KEYPAIR ?? `${HOME}/.config/solana/lean-mainnet-r4-oracle.json`;
  const funderPath = process.env.FUNDER_KEYPAIR ?? `${HOME}/.config/solana/id.json`;
  let oracle: Keypair | null = null, funder: Keypair | null = null;
  if (live) { oracle = loadKp(oraclePath); funder = process.env.FEE_PAYER === "oracle" ? oracle : loadKp(funderPath); }
  else { try { oracle = loadKp(oraclePath); } catch { /* dry run works without the key */ } }
  if (oracle && mani.oracleAuth && oracle.publicKey.toBase58() !== mani.oracleAuth) {
    throw new Error(`ORACLE_KEYPAIR pubkey ${oracle.publicKey.toBase58()} != manifest oracleAuth ${mani.oracleAuth}`);
  }

  const cfg = {
    live,
    thresholdBps: envNum("THRESHOLD_BPS", DEFAULT_KEEPER_CONFIG.thresholdBps, 0.01, 2_000),
    pollMs: envNum("POLL_MS", DEFAULT_KEEPER_CONFIG.pollMs, 200, 60_000),
    fastPollMs: envNum("FAST_POLL_MS", DEFAULT_KEEPER_CONFIG.fastPollMs, 100, 5_000),
    minIntervalMs: envNum("MIN_INTERVAL_MS", DEFAULT_KEEPER_CONFIG.minIntervalMs, 0, 3_600_000),
    maxPushesPerHour: envNum("MAX_PUSHES_PER_HOUR", DEFAULT_KEEPER_CONFIG.maxPushesPerHour, 1, 9_000),
    heartbeatFraction: envNum("HEARTBEAT_FRACTION", DEFAULT_KEEPER_CONFIG.heartbeatFraction, 0.01, 0.79),
    statsMs: envNum("STATS_MS", DEFAULT_KEEPER_CONFIG.statsMs, 1_000, 86_400_000),
    confirmTimeoutMs: envNum("CONFIRM_TIMEOUT_MS", DEFAULT_KEEPER_CONFIG.confirmTimeoutMs, 1_000, 60_000),
    rpcTimeoutMs: envNum("RPC_TIMEOUT_MS", DEFAULT_KEEPER_CONFIG.rpcTimeoutMs, 500, 30_000),
    guard: {
      agreeBps: envNum("AGREE_BPS", DEFAULT_SPOT_GUARD.agreeBps, 1, 1_000),
      singleSourceMaxGapBps: envNum("SINGLE_SOURCE_MAX_GAP_BPS", DEFAULT_SPOT_GUARD.singleSourceMaxGapBps, 0, 1_000),
      jumpBps: envNum("JUMP_BPS", DEFAULT_SPOT_GUARD.jumpBps, 1, 10_000),
      maxMarkGapBps: envNum("MAX_MARK_GAP_BPS", DEFAULT_SPOT_GUARD.maxMarkGapBps, 1, 10_000),
      holdDriftBps: envNum("HOLD_DRIFT_BPS", DEFAULT_SPOT_GUARD.holdDriftBps, 0, 10_000),
      maxHoldMs: envNum("MAX_HOLD_MS", DEFAULT_SPOT_GUARD.maxHoldMs, 0, 86_400_000),
    },
  };
  const half = process.env.HALF_SPREAD_BPS ? envNum("HALF_SPREAD_BPS", 0, 0.01, 10_000) : null;
  if (half !== null && cfg.thresholdBps > 0.75 * half) log(`WARNING THRESHOLD_BPS ${cfg.thresholdBps} > 0.75 x half-spread ${half}: stale-quote arbitrage becomes likely; use ${(0.5 * half).toFixed(1)}-${(0.75 * half).toFixed(1)} bps`);

  const onError = (name: string, err: string, retryInMs: number) => log(`WARNING source ${name} failed: ${err} (retry in ${Math.round(retryInMs / 1000)}s)`);
  let sources: SpotSource[];
  const spotFile = argOf("--spot-file");
  if (spotFile) {
    if (live) await assertDevnet(conn); // scripted prices may only ever sign on devnet
    log(`WARNING TEST HOOK: spot prices come from ${spotFile}, NOT from the exchanges`);
    const read = (name: string) => backoffSource(name, async () => {
      const p = JSON.parse(fs.readFileSync(spotFile, "utf8"))[name];
      if (typeof p !== "number") throw new Error("down (scripted)");
      return { price: p, tsMs: Date.now(), fetchedMs: Date.now() };
    }, { baseMs: 500, maxMs: 500, onError });
    sources = [read("coinbase"), read("kraken")];
  } else {
    const minFetchMs = Math.min(1_000, cfg.pollMs);
    sources = [coinbaseSource({ onError, minFetchMs }), krakenSource({ onError, minFetchMs })];
  }

  const release = acquireLock(lockFile);
  const keeper = new QuoteKeeper({ conn, programId, market, oracle, funder, sources, config: cfg, log });
  const ac = new AbortController();
  let lastHealthWrite = 0, lastCode = -1;
  const writeHealth = (force = false) => {
    const h = keeper.health(), now = Date.now();
    if (!force && h.code === lastCode && now - lastHealthWrite < 10_000) return;
    lastCode = h.code; lastHealthWrite = now;
    try {
      fs.writeFileSync(`${healthFile}.tmp`, JSON.stringify({ ...h, pid: process.pid, updatedMs: now, live, pushesTotal: keeper.stats.pushesTotal, maxAgeFraction: keeper.stats.maxAgeFraction }));
      fs.renameSync(`${healthFile}.tmp`, healthFile);
    } catch (e) { log(`WARNING cannot write health file: ${String(e).slice(0, 100)}`); }
  };
  let stopping = false;
  const stop = (sig: string) => { if (stopping) return; stopping = true; log(`${sig} received: shutting down`); ac.abort(); };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("exit", release);

  log(`manifest ${maniPath} program ${programId.toBase58()} oracle ${oracle ? oracle.publicKey.toBase58() : `${mani.oracleAuth ?? "?"} (key not loaded)`} lock ${lockFile} health ${healthFile}`);
  try {
    await keeper.run(ac.signal, () => writeHealth());
  } finally {
    writeHealth(true);
    release();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("_lean-quote-keeper.ts")) {
  main().then(() => process.exit(0), (e) => { console.error(`${ts()} FATAL ${maskSecrets(String((e as Error)?.message ?? e)).slice(0, 300)}`); process.exit(1); });
}
