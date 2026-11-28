/** EV+ lazy bidder (keeper) for the wSOL buy-and-burn reward auction — crash-safe / self-reconciling.
 *
 *  Runs one epoch (StartEpoch -> SubmitBid -> SettleEpoch -> ClaimQuote) ONLY when it is net profitable:
 *  sole-bidder profit-maximizing wSOL bid b* = sqrt(Q*Bvirt*1e3/P) - Bvirt (payout = Q*b/(b+Bvirt)), fired
 *  only if claimed USDC - burned wSOL - epoch rent > MIN_NET_USD.
 *  Dry by default (strictly read-only: no tx, no journal, no lock). Pass --live to execute. bidder = funder.
 *
 *  It can never wedge:
 *   - "An epoch is active" is `cfg.activeQuote > 0` (the gate StartEpoch itself uses). `cfg.activeEpochAcc`
 *     is NEVER cleared by the program — it keeps pointing at the last, already settled, epoch — so it must
 *     not be used as the "busy" signal.
 *   - Every run first RECONCILES from (journal + chain): an ended, unsettled active epoch is settled
 *     (permissionless — ours, foreign or unknown alike), our bid receipt on a settled epoch is claimed,
 *     a started-but-unbid epoch of ours is bid if the window is still open, a stale journal is cleared.
 *   - Atomic transactions: [createAccount(epoch) + StartEpoch] and
 *     [createATA(wSOL, idempotent) + wrap + syncNative + createAccount(bidReceipt) + SubmitBid]. No orphans.
 *   - Journal (JSON, 0600, tmp+rename) is written BEFORE each account-creating tx is sent, with that tx's
 *     lastValidBlockHeight, so a crash at any point is recoverable. On-chain state is always the truth; the
 *     journal only tells us which epoch / receipt pubkeys are ours. If the journal is lost, our receipts
 *     are re-discovered with getProgramAccounts (best effort).
 *   - O_EXCL lock file (pid + mtime stale detection) so two cron runs never interleave.
 *
 *  Env: SOLANA_RPC_URL (required), LEAN_MANIFEST (default lean-mainnet-r4.json),
 *       FUNDER_KEYPAIR (default ~/.config/solana/id.json),
 *       REWARD_BID_STATE_FILE (default ~/.config/solana/lean-r4-reward-bid-state.json; lock = <state>.lock),
 *       MIN_NET_USD (default 0.20), SOL_PRICE_USD (override the Coinbase spot price; tests),
 *       KEEPER_MAX_WAIT_SLOTS (default 750: longest in-process wait for an epoch to end),
 *       REWARD_BID_LOCK_STALE_MS (default 30 min),
 *       KEEPER_CRASH_AFTER=start|bid|settle (+ KEEPER_CRASH_HARD=1 for SIGKILL) — TEST-ONLY fault injection:
 *       dies right after that tx is confirmed, before the journal is advanced. Inert unless set. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, NATIVE_MINT } from "@solana/spl-token";
import bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";
import { rewardStartEpoch, rewardSubmitBid, rewardSettleEpoch, rewardClaimQuote, deriveDexVault, EPOCH_SIZE, BIDDER_SIZE, RewOff, EpochOff, MktOff } from "../src/lean/index.js";

// ---------------------------------------------------------------- config
const LIVE = process.argv.includes("--live");
const HOME = process.env.HOME ?? "";
const mask = (s: string) => s.replace(/api-key=[^&\s"']+/gi, "api-key=***");
if (!process.env.SOLANA_RPC_URL) { console.error("[reward-bid] ERR SOLANA_RPC_URL is not set"); process.exit(1); }
const conn = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
const m = JSON.parse(fs.readFileSync(process.env.LEAN_MANIFEST ?? "lean-mainnet-r4.json", "utf8"));
const RM = new PublicKey(m.rewardModule), P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MKT = new PublicKey(m.market);
const CFG = new PublicKey(m.rewardCfg), USDC = new PublicKey(m.usdc);
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${HOME}/.config/solana/id.json`, "utf8"))));
const bidder = funder; // bidder = funder, reuse funder ATAs
const STATE_FILE = process.env.REWARD_BID_STATE_FILE ?? `${HOME}/.config/solana/lean-r4-reward-bid-state.json`;
const LOCK_FILE = `${STATE_FILE}.lock`;
const MIN_NET_USD = process.env.MIN_NET_USD !== undefined ? Number(process.env.MIN_NET_USD) : 0.20; // require at least this much net profit to bother
const EPOCH_RENT_SOL = 0.0016;   // ~rent for the per-epoch 104B account (non-recovered)
const MAX_WAIT_SLOTS = Number(process.env.KEEPER_MAX_WAIT_SLOTS ?? 750);
const LOCK_STALE_MS = Number(process.env.REWARD_BID_LOCK_STALE_MS ?? 30 * 60_000);
const MIN_BID_SLOTS = 4;         // don't try to bid with fewer slots than this left in the window
const ATA_RENT = 2_039_280n, FEE_BUFFER = 5_000_000n;
const MAGIC_EPOCH = 0x48435045, MAGIC_BID = 0x52444942;
const BidOff = { magic: 0, cfg: 8, epochAcc: 40, bidder: 72, epochId: 104, amount: 112 } as const;
const RERR: Record<number, string> = { 405: "epochActive", 408: "belowMinBatch", 409: "epochClosed", 410: "epochNotEnded", 411: "epochMismatch" };

const U = (n: bigint) => (Number(n) / 1e6).toFixed(6);
const SOL = (n: bigint) => (Number(n) / 1e9).toFixed(6);
const log = (s: string) => console.log(`[reward-bid] ${s}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const g = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const pkAt = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));

// ---------------------------------------------------------------- rpc helpers
/** Retry READ-ONLY rpc calls on transient transport errors. */
async function rpc<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) {
      const s = String((e as Error)?.message ?? e);
      if (i < 6 && /429|Too Many|rate|timed? ?out|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|502|503|504/i.test(s)) { await sleep(1000 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function acct(pk: PublicKey) { const i = await rpc(() => conn.getAccountInfo(pk, "confirmed")); return i ? { owner: i.owner, data: Buffer.from(i.data), lamports: i.lamports } : null; }
/** SOL/USD used to size and gate bids. Sanity-ranged: a feed outage / garbage value falls back to a deliberately HIGH
 *  price. Overstating the SOL price overstates the burn cost, so the EV gate skips instead of bidding on a bad number
 *  (an understated price would be the dangerous direction). */
const SOL_PRICE_SANE = { min: 5, max: 5000 }, SOL_PRICE_FALLBACK = 1000;
async function solPriceUsd(): Promise<number> {
  const ok = (x: number) => Number.isFinite(x) && x >= SOL_PRICE_SANE.min && x <= SOL_PRICE_SANE.max;
  if (process.env.SOL_PRICE_USD) { const x = Number(process.env.SOL_PRICE_USD); if (ok(x)) return x; throw new Error(`SOL_PRICE_USD=${process.env.SOL_PRICE_USD} is outside [${SOL_PRICE_SANE.min}, ${SOL_PRICE_SANE.max}]`); }
  try { const r: any = await (await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")).json(); const x = parseFloat(r.data.amount); if (ok(x)) return x; log(`SOL price ${x} outside [${SOL_PRICE_SANE.min}, ${SOL_PRICE_SANE.max}] — using conservative fallback $${SOL_PRICE_FALLBACK}`); }
  catch { log(`SOL price unavailable — using conservative fallback $${SOL_PRICE_FALLBACK}`); }
  return SOL_PRICE_FALLBACK;
}
/** Hard ceiling on any single wSOL bid (defense in depth: the keeper signs with the funder key). */
const MAX_BID = BigInt(Math.round(Number(process.env.KEEPER_MAX_BID_SOL ?? 0.25) * 1e9));
async function tokenAmount(pk: PublicKey): Promise<bigint | null> { const a = await acct(pk); return a && a.data.length >= 72 ? g(a.data, 64) : null; }

/** A transaction that DEFINITELY failed (simulation or on-chain error) — it did not and will not land. */
class TxFailed extends Error {
  constructor(public code: number | null, msg: string) { super(msg); }
}
function customCode(x: unknown): number | null {
  const s = typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + " " + String((x as Error)?.message ?? "") + " " + ((x as any)?.logs ?? []).join(" ");
  let r = /"Custom":\s*(\d+)/.exec(s); if (r) return Number(r[1]);
  r = /custom program error: 0x([0-9a-fA-F]+)/.exec(s); if (r) return parseInt(r[1], 16);
  return null;
}
/** Sign + send + confirm by polling. Never double-lands: a new blockhash is only used once the previous
 *  attempt's blockhash has expired with no status. `onAttempt(lastValidBlockHeight)` runs BEFORE each send
 *  (used to journal the intent). Throws TxFailed on a definitive failure. */
async function sendTx(what: string, ixs: TransactionInstruction[], signers: Keypair[], onAttempt?: (lvbh: number) => void): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { blockhash, lastValidBlockHeight } = await rpc(() => conn.getLatestBlockhash("confirmed"));
    const tx = new Transaction({ feePayer: funder.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(funder, ...signers.filter(s => !s.publicKey.equals(funder.publicKey)));
    const raw = tx.serialize(), sig = bs58.encode(tx.signature!);
    onAttempt?.(lastValidBlockHeight);
    let lastSend = 0;
    for (;;) {
      if (Date.now() - lastSend > 2500) {
        lastSend = Date.now();
        try { await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 0 }); } catch (e) {
          const s = String((e as Error)?.message ?? e);
          if (/simulation failed|custom program error|InstructionError|insufficient|already in use/i.test(s) && !/already been processed|AlreadyProcessed|Blockhash not found/i.test(s)) {
            // Preflight said it would fail. Make sure an earlier broadcast of this same tx did not land.
            const st0 = (await rpc(() => conn.getSignatureStatuses([sig]))).value[0];
            if (!st0) throw new TxFailed(customCode(e), mask(`${what}: simulation failed: ${s.slice(0, 400)}`));
          } // else transport error / already processed: fall through to status polling
        }
      }
      const st = (await rpc(() => conn.getSignatureStatuses([sig]))).value[0];
      if (st) {
        if (st.err) throw new TxFailed(customCode(st.err), `${what}: tx ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return sig;
      } else if ((await rpc(() => conn.getBlockHeight("confirmed"))) > lastValidBlockHeight) {
        const fin = (await rpc(() => conn.getSignatureStatuses([sig], { searchTransactionHistory: true }))).value[0];
        if (fin?.err) throw new TxFailed(customCode(fin.err), `${what}: tx ${sig} failed on-chain: ${JSON.stringify(fin.err)}`);
        if (fin) return sig;
        log(`${what}: blockhash expired without landing (attempt ${attempt + 1}); retrying with a fresh blockhash`);
        break;
      }
      touchLock();
      await sleep(700);
    }
  }
  throw new Error(`${what}: could not land the transaction after 4 blockhashes`);
}

// ---------------------------------------------------------------- journal
type Stage = "started" | "bid" | "settled" | "claimed";
/** `stage` = the last step ATTEMPTED (it is written before the tx is sent). Chain state is the truth. */
interface Journal {
  version: 1; stage: Stage; cfg: string; bidder: string; epoch: string;
  bidReceipt?: string; bidAmount?: string;
  /** last valid block height of the most recent account-creating tx we sent (start or bid) */
  lastValidBlockHeight?: number;
  updatedAt: string;
}
function readJournal(): Journal | null {
  let txt: string;
  try { txt = fs.readFileSync(STATE_FILE, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const j = JSON.parse(txt) as Journal;
    new PublicKey(j.epoch); new PublicKey(j.cfg); new PublicKey(j.bidder); if (j.bidReceipt) new PublicKey(j.bidReceipt);
    return j;
  } catch {
    if (LIVE) { const aside = `${STATE_FILE}.corrupt-${Date.now()}`; fs.renameSync(STATE_FILE, aside); log(`journal unreadable -> moved aside to ${aside}; recovering from chain state`); }
    else log("journal unreadable (a live run would move it aside and recover from chain state)");
    return null;
  }
}
function writeJournal(j: Journal) {
  if (!LIVE) throw new Error("BUG: journal write in dry-run");
  j.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, JSON.stringify(j, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, STATE_FILE);
}
function clearJournal(why: string) {
  log(`${LIVE ? "journal cleared" : "DRY: would clear journal"}: ${why}`);
  if (LIVE) { try { fs.unlinkSync(STATE_FILE); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
}

// ---------------------------------------------------------------- lock (O_EXCL + stale detection)
let lockToken: string | null = null;
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } }
function tryCreateLock(): boolean {
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  try {
    const fd = fs.openSync(LOCK_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    lockToken = token; return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
}
/** @returns true if we hold the lock; false if another live run holds it. */
async function acquireLock(): Promise<boolean> {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (let i = 0; i < 3; i++) {
    if (tryCreateLock()) {
      // Guard the (tiny) stale-takeover race: make sure the lock is still ours a moment later.
      await sleep(150);
      let cur = ""; try { cur = fs.readFileSync(LOCK_FILE, "utf8"); } catch { /* gone */ }
      if (cur === lockToken) return true;
      lockToken = null; return false;
    }
    let content: string, mtimeMs: number;
    try { content = fs.readFileSync(LOCK_FILE, "utf8"); mtimeMs = fs.statSync(LOCK_FILE).mtimeMs; } catch { continue; } // vanished: retry
    const pid = parseInt(content.split(" ")[0] ?? "", 10);
    const age = Date.now() - mtimeMs;
    // A just-created lock may not have its pid written yet: give an empty/garbled lock 5s before calling it stale.
    const stale = Number.isFinite(pid) && pid > 0 ? (!pidAlive(pid) || age > LOCK_STALE_MS) : age > 5000;
    if (!stale) { log(`another run holds the lock (pid ${pid}, age ${Math.round(age / 1000)}s) — skipping this run. [${LOCK_FILE}]`); return false; }
    // Steal: atomically move the stale lock away, verify we moved the one we inspected, then re-create.
    const aside = `${LOCK_FILE}.stale.${process.pid}`;
    try { fs.renameSync(LOCK_FILE, aside); } catch { continue; }
    let moved = ""; try { moved = fs.readFileSync(aside, "utf8"); } catch { /* ignore */ }
    if (moved !== content) { try { fs.linkSync(aside, LOCK_FILE); } catch { /* someone re-created it */ } try { fs.unlinkSync(aside); } catch { /* ignore */ } continue; }
    try { fs.unlinkSync(aside); } catch { /* ignore */ }
    log(`removed stale lock (pid ${pid} ${Number.isFinite(pid) && pidAlive(pid) ? "alive but lock too old" : "not running"}, age ${Math.round(age / 1000)}s)`);
  }
  log("could not acquire the lock — skipping this run.");
  return false;
}
function touchLock() { if (lockToken) { try { const t = new Date(); fs.utimesSync(LOCK_FILE, t, t); } catch { /* ignore */ } } }
function releaseLock() {
  if (!lockToken) return;
  try { if (fs.readFileSync(LOCK_FILE, "utf8") === lockToken) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  lockToken = null;
}

// ---------------------------------------------------------------- test-only fault injection
function crashPoint(stage: "start" | "bid" | "settle") {
  if (process.env.KEEPER_CRASH_AFTER !== stage) return;
  log(`KEEPER_CRASH_AFTER=${stage}: injected crash (test only)`);
  if (process.env.KEEPER_CRASH_HARD === "1") process.kill(process.pid, "SIGKILL");
  throw new Error(`injected crash after ${stage} (KEEPER_CRASH_AFTER)`);
}

// ---------------------------------------------------------------- chain views
interface CfgView { activeEpochAcc: PublicKey; epochSlots: bigint; minBatch: bigint; reserveRateE6: bigint; activeEpochId: bigint; activeQuote: bigint; rollover: bigint; pending: bigint; burnMode: 0 | 1; quoteVault: PublicKey; targetEscrow: PublicKey; burnSink: PublicKey; targetMint: PublicKey }
interface EpochView { settled: boolean; epochId: bigint; quotePot: bigint; virtBids: bigint; totalBids: bigint; quotePaid: bigint; endSlot: bigint }
async function readCfg(): Promise<CfgView> {
  const a = await acct(CFG);
  if (!a || !a.owner.equals(RM) || a.data.length !== 400) throw new Error(`reward cfg ${CFG.toBase58()} missing or not a RewardCfg of ${RM.toBase58()}`);
  const b = a.data;
  return { activeEpochAcc: pkAt(b, RewOff.activeEpochAcc), epochSlots: g(b, RewOff.epochSlots), minBatch: g(b, RewOff.minBatchQuote), reserveRateE6: g(b, RewOff.reserveRateE6),
    activeEpochId: g(b, RewOff.activeEpochId), activeQuote: g(b, RewOff.activeQuote), rollover: g(b, RewOff.rolloverQuote), pending: g(b, RewOff.pendingClaims),
    burnMode: b[RewOff.burnMode] as 0 | 1, quoteVault: pkAt(b, RewOff.quoteVault), targetEscrow: pkAt(b, RewOff.targetEscrow), burnSink: pkAt(b, RewOff.burnSinkTok), targetMint: pkAt(b, RewOff.targetMint) };
}
/** An initialized EpochState of OUR cfg, else null (missing / foreign / not yet initialized). */
async function readEpoch(pk: PublicKey): Promise<EpochView | null> {
  const a = await acct(pk);
  if (!a || !a.owner.equals(RM) || a.data.length !== EPOCH_SIZE || a.data.readUInt32LE(EpochOff.magic) !== MAGIC_EPOCH || !pkAt(a.data, EpochOff.cfg).equals(CFG)) return null;
  const b = a.data;
  return { settled: b[EpochOff.settled] === 1, epochId: g(b, EpochOff.epochId), quotePot: g(b, EpochOff.quotePot), virtBids: g(b, EpochOff.virtBids), totalBids: g(b, EpochOff.totalBids), quotePaid: g(b, EpochOff.quotePaid), endSlot: g(b, EpochOff.endSlot) };
}
/** A live BidReceipt of ours for `epoch`: its bid amount, else null (missing / closed / not ours). */
async function readReceipt(pk: PublicKey, epoch: PublicKey): Promise<bigint | null> {
  const a = await acct(pk);
  if (!a || !a.owner.equals(RM) || a.data.length !== BIDDER_SIZE || a.data.readUInt32LE(BidOff.magic) !== MAGIC_BID) return null;
  if (!pkAt(a.data, BidOff.cfg).equals(CFG) || !pkAt(a.data, BidOff.epochAcc).equals(epoch) || !pkAt(a.data, BidOff.bidder).equals(bidder.publicKey)) return null;
  return g(a.data, BidOff.amount);
}
/** Best effort: all of our live bid receipts under this cfg (journal-loss recovery). */
async function findOurReceipts(): Promise<{ receipt: PublicKey; epoch: PublicKey; amount: bigint }[]> {
  try {
    const r = await rpc(() => conn.getProgramAccounts(RM, { commitment: "confirmed", filters: [{ dataSize: BIDDER_SIZE }, { memcmp: { offset: BidOff.cfg, bytes: CFG.toBase58() } }, { memcmp: { offset: BidOff.bidder, bytes: bidder.publicKey.toBase58() } }] }));
    return r.filter(x => Buffer.from(x.account.data).readUInt32LE(0) === MAGIC_BID).map(x => { const b = Buffer.from(x.account.data); return { receipt: x.pubkey, epoch: pkAt(b, BidOff.epochAcc), amount: g(b, BidOff.amount) }; });
  } catch (e) { log(`(receipt scan unavailable: ${mask(String((e as Error)?.message ?? e)).slice(0, 120)})`); return []; }
}
/** Sole-bidder profit-maximizing bid: d/db [Q*b/(b+Bvirt)/1e6 - b/1e9*P] = 0 -> b* = sqrt(Q*Bvirt*1e3/P) - Bvirt */
function optimalBid(Q: bigint, Bvirt: bigint, P_sol: number) {
  const bF = Math.sqrt(Number(Q) * Number(Bvirt) * 1000 / P_sol) - Number(Bvirt);
  let bid = BigInt(Math.max(1, Math.floor(bF)));
  if (bid > MAX_BID) bid = MAX_BID;
  const payoutUsd = Number(Q * bid / (bid + Bvirt)) / 1e6, burnUsd = Number(bid) / 1e9 * P_sol;
  return { bid, payoutUsd, burnUsd };
}

// ---------------------------------------------------------------- the keeper
async function run() {
  const P_sol = await solPriceUsd();
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, bidder.publicKey);
  const usdcAta = getAssociatedTokenAddressSync(USDC, bidder.publicKey);
  const dexVault = deriveDexVault(P, DEX)[0];
  const [rentE, rentB] = await Promise.all([rpc(() => conn.getMinimumBalanceForRentExemption(EPOCH_SIZE)), rpc(() => conn.getMinimumBalanceForRentExemption(BIDDER_SIZE))]);

  let J = readJournal();
  let startedThisRun = false, claimedThisRun = false, scanned = false, settle410 = 0;
  let declinedEpoch = ""; // epoch pubkey we decided not to bid on (per epoch, never carried over to the next one)
  const waitForEnd = async (endSlot: bigint, slot: number): Promise<boolean> => {
    const remaining = Number(endSlot) - slot;
    if (remaining > MAX_WAIT_SLOTS) { log(`epoch ends in ${remaining} slots (> KEEPER_MAX_WAIT_SLOTS=${MAX_WAIT_SLOTS}); leaving it journaled — the next run settles + claims.`); return false; }
    log(`waiting ${remaining} slots for the epoch to end (endSlot ${endSlot})...`);
    while ((await rpc(() => conn.getSlot("confirmed"))) < Number(endSlot)) { touchLock(); await sleep(800); }
    return true;
  };

  for (let iter = 0; iter < 40; iter++) {
    const [c, slot] = await Promise.all([readCfg(), rpc(() => conn.getSlot("confirmed"))]);
    if (iter === 0) {
      if (!c.targetMint.equals(NATIVE_MINT)) throw new Error(`cfg target mint ${c.targetMint.toBase58()} is not wSOL — this keeper only handles the wSOL buy-and-burn`);
      for (const [k, v] of [["quoteVault", c.quoteVault], ["targetEscrow", c.targetEscrow], ["burnSink", c.burnSink]] as const) if (m[k] && m[k] !== v.toBase58()) log(`WARN manifest ${k} ${m[k]} != cfg ${v.toBase58()} (using the on-chain cfg value)`);
    }
    const active = c.activeQuote > 0n; // the program's own "epoch active" gate (activeEpochAcc is never cleared)

    // ---- 0. journal sanity -------------------------------------------------------------------
    if (J && (J.cfg !== CFG.toBase58() || J.bidder !== bidder.publicKey.toBase58())) {
      if (LIVE) { const aside = `${STATE_FILE}.other-${Date.now()}`; fs.renameSync(STATE_FILE, aside); log(`journal belongs to another cfg/bidder (${J.cfg}) -> moved aside to ${aside}`); }
      else log(`journal belongs to another cfg/bidder (${J.cfg}) (a live run would move it aside)`);
      J = null; continue;
    }
    // ---- 0b. journal lost? re-discover our receipts from chain (once per run) ------------------
    if (!scanned) {
      scanned = true;
      for (const r of await findOurReceipts()) {
        if (J && J.bidReceipt === r.receipt.toBase58()) continue;
        const ep = await readEpoch(r.epoch);
        if (!ep) continue;
        if (ep.settled) {
          log(`found an unjournaled bid receipt ${r.receipt.toBase58()} (${SOL(r.amount)} wSOL) on settled epoch #${ep.epochId} -> claiming`);
          if (!LIVE) { log("DRY: would ClaimQuote it."); continue; }
          await claim(r.epoch, r.receipt, usdcAta, c);
        } else if (!J) {
          log(`found our unjournaled bid receipt ${r.receipt.toBase58()} on the ACTIVE epoch #${ep.epochId} -> adopting it`);
          J = { version: 1, stage: "bid", cfg: CFG.toBase58(), bidder: bidder.publicKey.toBase58(), epoch: r.epoch.toBase58(), bidReceipt: r.receipt.toBase58(), bidAmount: r.amount.toString(), updatedAt: "" };
          if (LIVE) writeJournal(J);
        }
      }
    }

    // ---- 1. our journaled epoch ----------------------------------------------------------------
    let oursActive = false, ourBid: bigint | null = null;
    if (J) {
      const jEpochPk = new PublicKey(J.epoch);
      const je = await readEpoch(jEpochPk);
      const inFlight = J.lastValidBlockHeight !== undefined && (await rpc(() => conn.getBlockHeight("confirmed"))) <= J.lastValidBlockHeight;
      if (!je) {
        if (inFlight) { log(`journaled StartEpoch for ${J.epoch} may still be in flight (blockhash not expired) — skipping this run.`); return; }
        clearJournal(`epoch ${J.epoch} was never created on-chain (StartEpoch tx did not land)`); J = null; continue;
      }
      ourBid = J.bidReceipt ? await readReceipt(new PublicKey(J.bidReceipt), jEpochPk) : null;
      if (je.settled) {
        if (ourBid !== null) {
          if (!LIVE) { log(`DRY: would ClaimQuote receipt ${J.bidReceipt} (${SOL(ourBid)} wSOL) on settled epoch #${je.epochId}.`); return; }
          await claim(jEpochPk, new PublicKey(J.bidReceipt!), usdcAta, c);
          J.stage = "claimed"; writeJournal(J); claimedThisRun = true;
        }
        clearJournal(ourBid !== null ? `epoch #${je.epochId} complete (claimed)` : `epoch #${je.epochId} is settled and we hold no live receipt on it (no bid landed, or already claimed)`);
        J = null; continue;
      }
      if (!active || !c.activeEpochAcc.equals(jEpochPk)) { clearJournal(`journaled epoch ${J.epoch} is unsettled but not the cfg's active epoch (unexpected)`); J = null; continue; }
      oursActive = true;
      if (ourBid === null && J.bidReceipt && inFlight && slot < Number(je.endSlot)) { log("journaled SubmitBid may still be in flight; waiting..."); await sleep(2000); continue; }
      if (ourBid !== null && J.stage === "started" && LIVE) { J.stage = "bid"; writeJournal(J); }
    }

    // ---- 2. the cfg's active epoch (ours, foreign or unknown) ------------------------------------
    if (active) {
      const epPk = c.activeEpochAcc;
      const ep = await readEpoch(epPk);
      if (!ep) throw new Error(`cfg.activeQuote > 0 but active epoch ${epPk.toBase58()} is unreadable`);
      const who = oursActive ? "our" : "a foreign/unknown";
      if (slot >= Number(ep.endSlot)) {
        // ended + unsettled -> settle it (permissionless). Never blocked by someone else's epoch.
        log(`${who} epoch #${ep.epochId} (${epPk.toBase58()}) ended at slot ${ep.endSlot} (now ${slot}), unsettled, totalBids=${SOL(ep.totalBids)} wSOL -> SettleEpoch`);
        if (!LIVE) { log("DRY: would SettleEpoch it" + (oursActive && ourBid !== null ? " and then ClaimQuote our receipt." : ".")); return; }
        try {
          const sig = await sendTx("SettleEpoch", [rewardSettleEpoch(RM, { cfg: CFG, epochAcc: epPk, targetEscrow: c.targetEscrow, targetMint: NATIVE_MINT, burnSink: c.burnSink, burnMode: c.burnMode })], []);
          log(`settled epoch #${ep.epochId}: ${sig}`);
        } catch (e) {
          if (!(e instanceof TxFailed)) throw e;
          if (e.code === 410 && settle410++ < 10) { await sleep(1500); continue; }           // RPC slot ahead of the bank: retry shortly
          const again = await readEpoch(epPk);
          if (!again?.settled) throw e;
          log(`epoch #${ep.epochId} was settled by someone else meanwhile (${RERR[e.code ?? -1] ?? e.code}).`);
        }
        crashPoint("settle");
        if (oursActive && J) { J.stage = "settled"; writeJournal(J); }
        continue;
      }
      const remaining = Number(ep.endSlot) - slot;
      if (!oursActive) { log(`a foreign/unknown epoch #${ep.epochId} (${epPk.toBase58()}) is still running (${remaining} slots left) — skipping this run; a later run settles it if nobody else does.`); return; }
      if (ourBid !== null) {
        log(`our epoch #${ep.epochId} is running with our bid of ${SOL(ourBid)} wSOL escrowed (${remaining} slots left).`);
        if (!LIVE) { log("DRY: would wait for the epoch to end, then SettleEpoch + ClaimQuote."); return; }
        if (!(await waitForEnd(ep.endSlot, slot))) return;
        continue;
      }
      // ours, running, no bid yet -> bid (or leave it to roll over; never wedge)
      const { bid, payoutUsd, burnUsd } = optimalBid(ep.quotePot, ep.virtBids, P_sol);
      const have = BigInt(await rpc(() => conn.getBalance(bidder.publicKey, "confirmed")));
      const wsolHave = (await tokenAmount(wsolAta)) ?? 0n;
      const wrap = bid > wsolHave ? bid - wsolHave : 0n;
      let why = "";
      const declinedBid = declinedEpoch === epPk.toBase58();
      if (declinedBid) why = "already declined";
      else if (payoutUsd - burnUsd <= 0) why = `bid not EV+ at live Q=$${U(ep.quotePot)} Bvirt=${ep.virtBids} (claim $${payoutUsd.toFixed(4)} <= burn $${burnUsd.toFixed(4)})`;
      else if (remaining < MIN_BID_SLOTS) why = `bid window nearly closed (${remaining} slots left)`;
      else if (have < wrap + BigInt(rentB) + ATA_RENT + FEE_BUFFER) why = `insufficient SOL (${SOL(have)}) for a ${SOL(bid)} wSOL bid`;
      if (why) {
        if (!declinedBid) log(`our epoch #${ep.epochId} is running without a bid; NOT bidding: ${why}. The quote rolls over at settle (no loss).`);
        declinedEpoch = epPk.toBase58();
        if (!LIVE) { log("DRY: would wait for the epoch to end and SettleEpoch it (rollover)."); return; }
        if (!(await waitForEnd(ep.endSlot, slot))) return;
        continue;
      }
      log(`our epoch #${ep.epochId}: Q=$${U(ep.quotePot)} Bvirt=${ep.virtBids} -> bid ${SOL(bid)} wSOL, expect claim $${payoutUsd.toFixed(4)} burn $${burnUsd.toFixed(4)} (${remaining} slots left)`);
      if (!LIVE) { log("DRY: would SubmitBid, wait, SettleEpoch and ClaimQuote."); return; }
      const receipt = Keypair.generate();
      const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(bidder.publicKey, wsolAta, bidder.publicKey, NATIVE_MINT)];
      if (wrap > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: bidder.publicKey, toPubkey: wsolAta, lamports: Number(wrap) }));
      ixs.push(createSyncNativeInstruction(wsolAta),
        SystemProgram.createAccount({ fromPubkey: bidder.publicKey, newAccountPubkey: receipt.publicKey, lamports: rentB, space: BIDDER_SIZE, programId: RM }),
        rewardSubmitBid(RM, { cfg: CFG, epochAcc: epPk, bidReceipt: receipt.publicKey, bidder: bidder.publicKey, bidderTargetTok: wsolAta, targetEscrow: c.targetEscrow, targetMint: NATIVE_MINT, amount: bid }));
      const j: Journal = J!;
      try {
        // journal the receipt pubkey BEFORE the tx that creates it is sent
        const sig = await sendTx("SubmitBid", ixs, [receipt], lvbh => { j.stage = "bid"; j.bidReceipt = receipt.publicKey.toBase58(); j.bidAmount = bid.toString(); j.lastValidBlockHeight = lvbh; writeJournal(j); });
        log(`bid ${SOL(bid)} wSOL escrowed (receipt ${receipt.publicKey.toBase58()}): ${sig}`);
      } catch (e) {
        if (!(e instanceof TxFailed)) throw e;                 // unknown outcome: journal has the receipt; next loop/run reconciles
        // definitive failure: the atomic tx did nothing (no receipt, no wSOL moved). Forget the receipt.
        delete j.bidReceipt; delete j.bidAmount; delete j.lastValidBlockHeight; j.stage = "started"; writeJournal(j);
        if (e.code === 409) { log("SubmitBid: bid window closed before the bid landed (epochClosed) — the quote rolls over at settle."); declinedEpoch = epPk.toBase58(); continue; }
        throw e;
      }
      crashPoint("bid");
      continue;
    }

    // ---- 3. idle: EV gate, then start a new epoch --------------------------------------------------
    // one cycle per run: after starting an epoch or collecting a payout we are done (a resumed, bid-less
    // epoch that merely rolled over does NOT count — we go on and start a fresh one if it is still EV+).
    if (startedThisRun || claimedThisRun) { log("epoch cycle complete for this run."); return; }
    const mk = await acct(MKT);
    const accrued = mk && mk.owner.equals(P) && mk.data.length >= MktOff.rewardAccrued + 8 ? g(mk.data, MktOff.rewardAccrued) : 0n; // rewardAccrued (will be pulled into the pot)
    const Q = accrued + c.rollover;                                  // projected pot (USDC 1e6 units)
    const Bvirt = (Q * c.reserveRateE6 + 999_999n) / 1_000_000n;     // ceil(Q*rate/1e6)
    const { bid: bStar, payoutUsd, burnUsd } = optimalBid(Q, Bvirt, P_sol);
    const netUsd = payoutUsd - burnUsd - EPOCH_RENT_SOL * P_sol;     // tx fees ~negligible
    log(`accrued=$${U(accrued)} rollover=$${U(c.rollover)} -> Q=$${U(Q)} | reserveRateE6=${c.reserveRateE6} Bvirt=${Bvirt} | SOL=$${P_sol.toFixed(2)} activeEpoch=false (lastEpochId=${c.activeEpochId})`);
    log(`optimal bid b*=${SOL(bStar)} SOL -> claim $${payoutUsd.toFixed(4)} | burn $${burnUsd.toFixed(4)} | net(after epoch rent) $${netUsd.toFixed(4)}`);
    if (Q < c.minBatch) { log(`SKIP: pot $${U(Q)} < minBatch $${U(c.minBatch)}.`); return; }
    if (netUsd < MIN_NET_USD) { log(`SKIP: net $${netUsd.toFixed(4)} < MIN_NET $${MIN_NET_USD}. (waiting for a bigger pot / lower reserve)`); return; }
    const have = BigInt(await rpc(() => conn.getBalance(bidder.publicKey, "confirmed")));
    const need = bStar + BigInt(rentE) + BigInt(rentB) + 2n * ATA_RENT + FEE_BUFFER;
    if (have < need) { log(`SKIP: bidder has ${SOL(have)} SOL, needs ~${SOL(need)} SOL for the epoch.`); return; }
    if (!LIVE) { log(`DRY: would fire this epoch (net +$${netUsd.toFixed(4)}). Re-run with --live to execute.`); return; }

    const epoch = Keypair.generate();
    const j: Journal = { version: 1, stage: "started", cfg: CFG.toBase58(), bidder: bidder.publicKey.toBase58(), epoch: epoch.publicKey.toBase58(), updatedAt: "" };
    try {
      // journal the epoch pubkey BEFORE the tx that creates it is sent; create + StartEpoch are atomic
      const sig = await sendTx("StartEpoch", [
        SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: epoch.publicKey, lamports: rentE, space: EPOCH_SIZE, programId: RM }),
        rewardStartEpoch(RM, { cfg: CFG, epochAcc: epoch.publicKey, dex: DEX, market: MKT, quoteMint: USDC, dexVault, quoteVault: c.quoteVault, percolator: P }),
      ], [epoch], lvbh => { j.lastValidBlockHeight = lvbh; writeJournal(j); });
      log(`started epoch ${epoch.publicKey.toBase58()}: ${sig}`);
    } catch (e) {
      if (!(e instanceof TxFailed)) throw e;                   // unknown outcome: stays journaled; the next run reconciles
      clearJournal("StartEpoch tx definitively failed (nothing was created)");
      if (e.code === 405) { log("StartEpoch raced with another starter (epochActive) — reconciling."); J = null; continue; }
      if (e.code === 408) { log("StartEpoch: pot fell below minBatch (belowMinBatch) — nothing to do."); return; }
      throw e;
    }
    J = j; startedThisRun = true;
    crashPoint("start");
  }
  throw new Error("reconcile loop did not converge (40 iterations) — state left journaled for the next run");
}

/** ClaimQuote for one of our receipts on a settled epoch (creates the quote ATA if needed; closes the receipt). */
async function claim(epochPk: PublicKey, receiptPk: PublicKey, usdcAta: PublicKey, c: CfgView) {
  const before = (await tokenAmount(usdcAta)) ?? 0n;
  try {
    const sig = await sendTx("ClaimQuote", [
      createAssociatedTokenAccountIdempotentInstruction(bidder.publicKey, usdcAta, bidder.publicKey, USDC),
      rewardClaimQuote(RM, { cfg: CFG, epochAcc: epochPk, bidReceipt: receiptPk, bidder: bidder.publicKey, quoteVault: c.quoteVault, bidderQuoteTok: usdcAta, quoteMint: USDC }),
    ], []);
    const got = ((await tokenAmount(usdcAta)) ?? 0n) - before;
    log(`DONE: claimed $${U(got)} USDC (receipt ${receiptPk.toBase58()} closed, rent refunded) — buy-and-burn complete: ${sig}`);
  } catch (e) {
    if (e instanceof TxFailed && (await readReceipt(receiptPk, epochPk)) === null) { log("ClaimQuote: receipt already closed (claimed earlier)."); return; }
    throw e;
  }
}

async function main() {
  log(`${LIVE ? "LIVE" : "DRY"} cfg=${CFG.toBase58()} bidder=${bidder.publicKey.toBase58()}`);
  if (!LIVE) { await run(); return; }                          // dry-run: strictly read-only, no lock
  if (!(await acquireLock())) return;
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { releaseLock(); process.exit(130); });
  try { await run(); } finally { releaseLock(); }
}
main().then(() => process.exit(0)).catch(e => { console.error("[reward-bid] ERR", mask(String((e as Error)?.message ?? e)).slice(0, 600)); process.exit(1); });
