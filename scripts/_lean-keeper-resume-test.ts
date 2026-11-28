/** DEVNET proof that the reward-auction keeper (scripts/_lean-r3-reward-bid.ts) can never wedge.
 *  Creates a fresh dex / market / wSOL buy-and-burn reward cfg (mirrors _lean-e2e.ts), writes a temp manifest +
 *  temp journal + a throwaway bidder keypair, then spawns the REAL keeper script as child processes and checks:
 *   (e)  dry run (idle and mid-flight) sends nothing and writes nothing
 *   (a1) crash after StartEpoch, resume inside the bid window  -> bids, settles, claims
 *   (a2) crash after StartEpoch, resume after the epoch expired -> settles the empty epoch, starts a fresh one, completes
 *   (a3) crash after StartEpoch, bid no longer EV+ on resume   -> no bid, epoch settled empty (rollover), not wedged
 *   (b1) SIGKILL after SubmitBid (stale lock left behind)       -> next run takes the lock over, settles, claims
 *   (b2) crash after SubmitBid + journal LOST                    -> receipt re-discovered on chain, settles, claims
 *   (b3) crash after SettleEpoch                                  -> next run claims
 *   (c)  a foreign epoch (other key, with a foreign bid): skipped while running, settled once expired, keeper proceeds
 *   (d)  two concurrent invocations -> the second skips via the lock; exactly one epoch is run
 *   (f)  after every case: V == SPL vault (+ full dex invariants) and the reward 3-bucket accounting is exact
 *  DEVNET ONLY (refuses any other cluster). Usage: SOLANA_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-keeper-resume-test.ts
 *  Env: KEEPER_TEST_DIR (temp dir, default os.tmpdir()), KEEPER_TEST_EPOCH_SLOTS (default 64). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo, createSyncNativeInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, REWARD_CFG_SIZE, EPOCH_SIZE, BIDDER_SIZE, POS_SCALE, TRADE_MODE, RewOff, EpochOff,
  initDex, createMarket, initPortfolio, depositCollateral, depositInsurance, trade,
  rewardInit, rewardStartEpoch, rewardSubmitBid,
  deriveDexVault, deriveRewAuth, parseDex, parseMarket, parsePortfolio, checkDexInvariants, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const mask = (s: string) => s.replace(/api-key=[^&\s"']+/gi, "api-key=***");
const conn = new Connection(RPC, "confirmed");
const P = LEAN_DEVNET.percolator, RM = LEAN_DEVNET.rewardModule;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")))); // admin / "foreign" key
const EPOCH_SLOTS = BigInt(process.env.KEEPER_TEST_EPOCH_SLOTS ?? 64);
const KEEPER = path.resolve("scripts/_lean-r3-reward-bid.ts"), TSX = path.resolve("node_modules/.bin/tsx");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found|fetch failed/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp; }
const buf = async (pk: PublicKey) => { const i = await conn.getAccountInfo(pk, "confirmed"); return i ? Buffer.from(i.data) : null; };
const tokBal = async (t: PublicKey) => { const b = await buf(t); return b ? b.readBigUInt64LE(64) : 0n; };
const U = (n: bigint) => (Number(n) / 1e6).toFixed(4);
const g = (b: Buffer, o: number) => b.readBigUInt64LE(o);
async function waitUntilSlot(n: number) { while ((await conn.getSlot("confirmed")) < n) await sleep(600); }

async function main() {
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`refusing to run: RPC is not devnet (genesis ${genesis})`);
  const dir = fs.mkdtempSync(path.join(process.env.KEEPER_TEST_DIR ?? os.tmpdir(), "lean-keeper-test-"));
  const manifestPath = path.join(dir, "manifest.json"), statePath = path.join(dir, "state.json"), lockPath = `${statePath}.lock`, bidderPath = path.join(dir, "bidder.json");
  console.log(`devnet ok. temp dir ${dir}  epochSlots=${EPOCH_SLOTS}`);

  // ---------- setup: fresh mint / dex / market / reward cfg (as _lean-e2e.ts) ----------
  const USDC = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, USDC, fTok, funder, 1_000_000n * POS_SCALE);
  const dex = (await newAcc(P, DEX_SIZE)).publicKey;
  await send([initDex(P, { dex, admin: funder.publicKey, mint: USDC, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint: USDC, vault: deriveDexVault(P, dex)[0] };
  const cfg = (await newAcc(RM, REWARD_CFG_SIZE)).publicKey;
  const [rewAuth] = deriveRewAuth(RM, cfg);
  const BTC = 95_000n * POS_SCALE;
  const params: MarketParams = { initPrice: BTC, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 100n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, rewardBps: 10000n, rewardRecipient: rewAuth };
  const mkt = (await newAcc(P, MARKET_SIZE)).publicKey;
  await send([createMarket(P, { dex, market: mkt, mint: USDC, oracleAuth: Keypair.generate().publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const quoteVault = await createAccount(conn, funder, USDC, rewAuth, Keypair.generate());
  const targetEscrow = await createAccount(conn, funder, NATIVE_MINT, rewAuth, Keypair.generate());
  const burnSink = await createAccount(conn, funder, NATIVE_MINT, rewAuth, Keypair.generate());
  await send([rewardInit(RM, { cfg, mktAdmin: funder.publicKey, percolator: P, dex, market: mkt, quoteMint: USDC, quoteVault, targetMint: NATIVE_MINT, targetEscrow, burnSink, burnMode: 1, epochSlots: EPOCH_SLOTS, minBatchQuote: 1n * POS_SCALE, reserveRateE6: 1n * POS_SCALE })]);
  const rIns = (await newAcc(P, INS_RECEIPT_SIZE)).publicKey;
  await send([depositInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  const oU = Keypair.generate(), oC = Keypair.generate();
  const pflU = (await newAcc(P, PORTFOLIO_SIZE)).publicKey, pflC = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflU, owner: oU.publicKey })], [oU]);
  await send([initPortfolio(P, { dex, portfolio: pflC, owner: oC.publicKey })], [oC]);
  await send([depositCollateral(P, V, { portfolio: pflU, depositor: funder.publicKey, sourceToken: fTok, amount: 20_000n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pflC, depositor: funder.publicKey, sourceToken: fTok, amount: 20_000n * POS_SCALE })]);

  // throwaway bidder (the keeper's "funder"), temp manifest
  const bidder = Keypair.generate();
  fs.writeFileSync(bidderPath, JSON.stringify(Array.from(bidder.secretKey)), { mode: 0o600 });
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: bidder.publicKey, lamports: 1_500_000_000 })]);
  fs.writeFileSync(manifestPath, JSON.stringify({ network: "devnet", percolator: P.toBase58(), rewardModule: RM.toBase58(), usdc: USDC.toBase58(), dex: dex.toBase58(), market: mkt.toBase58(),
    rewardCfg: cfg.toBase58(), rewAuth: rewAuth.toBase58(), quoteVault: quoteVault.toBase58(), targetEscrow: targetEscrow.toBase58(), burnSink: burnSink.toBase58() }, null, 2));
  const bidderUsdc = getAssociatedTokenAddressSync(USDC, bidder.publicKey);
  let solPrice = 130; try { const r: any = await (await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")).json(); solPrice = parseFloat(r.data.amount) || 130; } catch { /* keep default */ }
  console.log(`setup done: dex ${dex.toBase58()} market ${mkt.toBase58()} cfg ${cfg.toBase58()} bidder ${bidder.publicKey.toBase58()} SOL=$${solPrice}`);

  // ---------- helpers ----------
  const cfgView = async () => { const b = (await buf(cfg))!; return { activeEpochAcc: new PublicKey(b.subarray(RewOff.activeEpochAcc, RewOff.activeEpochAcc + 32)), epochId: g(b, RewOff.activeEpochId), activeQuote: g(b, RewOff.activeQuote), rollover: g(b, RewOff.rolloverQuote), pending: g(b, RewOff.pendingClaims), spent: g(b, RewOff.totalQuoteSpent), burned: g(b, RewOff.totalTargetBurned), rate: g(b, RewOff.reserveRateE6) }; };
  const epochView = async (pk: PublicKey) => { const b = (await buf(pk))!; return { settled: b[EpochOff.settled] === 1, totalBids: g(b, EpochOff.totalBids), endSlot: Number(g(b, EpochOff.endSlot)), quotePot: g(b, EpochOff.quotePot), quotePaid: g(b, EpochOff.quotePaid) }; };
  /** trade open+close (1% fee each way, rewardBps=100%) until the market has accrued >= `usd` of reward. */
  const accrue = async (usd: bigint) => {
    for (let i = 0; i < 12; i++) {
      const acc = parseMarket((await buf(mkt))!).rewardAccrued;
      if (acc >= usd * POS_SCALE) { console.log(`  (rewardAccrued = $${U(acc)})`); return; }
      for (const mode of [TRADE_MODE.OPEN, TRADE_MODE.CLOSE]) await send([trade(P, { dex, market: mkt, longPortfolio: pflU, longOwner: oU.publicKey, shortPortfolio: pflC, shortOwner: oC.publicKey, mode, qty: 5000n })], [oU, oC]);
    }
    throw new Error("could not accrue enough reward");
  };
  const keeper = (args: string[], extra: Record<string, string> = {}, tag = "keeper") => new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SOLANA_RPC_URL: RPC, LEAN_MANIFEST: manifestPath, FUNDER_KEYPAIR: bidderPath, REWARD_BID_STATE_FILE: statePath, SOL_PRICE_USD: String(solPrice), ...extra };
    const ch = spawn(TSX, [KEEPER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const on = (d: Buffer) => { const s = mask(d.toString()); out += s; for (const l of s.split("\n")) if (l.trim()) console.log(`    ${tag}| ${l}`); };
    ch.stdout.on("data", on); ch.stderr.on("data", on);
    ch.on("close", (code, signal) => resolve({ code, signal, out }));
  });
  const journal = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; } };
  /** (f) conservation + reward accounting + "not wedged" */
  const consistent = async (label: string, expectIdle = true) => {
    const d = parseDex((await buf(dex))!), spl = await tokBal(V.vault);
    const inv = checkDexInvariants(d, spl, [parseMarket((await buf(mkt))!)], [parsePortfolio((await buf(pflU))!), parsePortfolio((await buf(pflC))!)]);
    ok(d.vaultBalance === spl && inv.ok, `(f) ${label}: conservation V ${U(d.vaultBalance)} == SPL vault ${U(spl)}; dex invariants ok${inv.ok ? "" : " — " + inv.problems.join("; ")}`);
    const c = await cfgView(), qv = await tokBal(quoteVault), esc = await tokBal(targetEscrow), sink = await tokBal(burnSink);
    ok(qv === c.activeQuote + c.rollover + c.pending, `(f) ${label}: reward quoteVault ${U(qv)} == activeQuote ${U(c.activeQuote)} + rollover ${U(c.rollover)} + pendingClaims ${U(c.pending)}`);
    const live = c.activeQuote > 0n ? (await epochView(c.activeEpochAcc)).totalBids : 0n;
    ok(esc === live && sink === c.burned, `(f) ${label}: targetEscrow ${esc} == live epoch bids ${live}; burnSink ${sink} == totalTargetBurned ${c.burned}`);
    if (expectIdle) ok(c.activeQuote === 0n && !fs.existsSync(statePath) && !fs.existsSync(lockPath), `${label}: NOT wedged — no active epoch (activeQuote=0), journal cleared, lock released`);
    return c;
  };
  const fingerprint = async () => JSON.stringify({ lam: await conn.getBalance(bidder.publicKey, "confirmed"), sig: (await conn.getSignaturesForAddress(bidder.publicKey, { limit: 1 }, "confirmed"))[0]?.signature ?? null,
    cfg: (await buf(cfg))!.toString("hex"), state: fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null, lock: fs.existsSync(lockPath), files: fs.readdirSync(dir).sort() });

  // ================= (e) dry run, idle =================
  console.log("\n(e) dry run on an idle cfg with a fat pot: must be strictly read-only");
  await accrue(8n);
  let fp = await fingerprint();
  let r = await keeper([]);
  ok(r.code === 0 && /DRY: would fire this epoch/.test(r.out), "(e) dry run passes the EV gate and reports 'would fire'");
  ok((await fingerprint()) === fp, "(e) dry run sent no tx (bidder lamports + last signature + cfg unchanged), wrote no journal, no lock, no files");

  // ================= (a1) crash after StartEpoch, resume in-window =================
  console.log("\n(a1) crash right after StartEpoch -> resume inside the bid window");
  let c0 = await cfgView(); let usdc0 = await tokBal(bidderUsdc);
  r = await keeper(["--live"], { KEEPER_CRASH_AFTER: "start" });
  let j = journal(); let c = await cfgView();
  ok(r.code === 1 && /injected crash/.test(r.out), "(a1) keeper crashed after StartEpoch (exit 1)");
  ok(j?.stage === "started" && j.epoch === c.activeEpochAcc.toBase58() && c.activeQuote > 0n && !j.bidReceipt, `(a1) epoch is active on-chain and journaled (stage=started, epoch ${j?.epoch})`);
  ok((fs.statSync(statePath).mode & 0o777) === 0o600 && !fs.existsSync(lockPath), "(a1) journal is mode 0600; lock released by the crashing run");
  fp = await fingerprint();
  r = await keeper([]);
  ok(r.code === 0 && /DRY: would SubmitBid/.test(r.out) && (await fingerprint()) === fp, "(e) dry run mid-flight (journaled, unbid epoch): reports 'would SubmitBid', changes nothing on chain or disk");
  r = await keeper(["--live"]);
  c = await cfgView();
  ok(r.code === 0 && /wSOL escrowed/.test(r.out) && /settled epoch/.test(r.out) && /DONE: claimed/.test(r.out), "(a1) next run resumed: SubmitBid -> SettleEpoch -> ClaimQuote");
  ok(c.epochId === c0.epochId + 1n, `(a1) exactly one epoch used (epochId ${c0.epochId} -> ${c.epochId}); no second StartEpoch for the resumed epoch`);
  ok((await tokBal(bidderUsdc)) > usdc0, `(a1) USDC received: +$${U((await tokBal(bidderUsdc)) - usdc0)}`);
  await consistent("a1");

  // ================= (a2) crash after StartEpoch, resume after expiry =================
  console.log("\n(a2) crash right after StartEpoch -> resume only after the epoch expired (the realistic 6h-cron case)");
  await accrue(8n);
  c0 = await cfgView(); usdc0 = await tokBal(bidderUsdc);
  r = await keeper(["--live"], { KEEPER_CRASH_AFTER: "start" });
  c = await cfgView();
  ok(r.code === 1 && c.activeQuote > 0n && journal()?.stage === "started", "(a2) crashed after StartEpoch; epoch active + journaled");
  await waitUntilSlot((await epochView(c.activeEpochAcc)).endSlot + 2);
  r = await keeper(["--live"]);
  c = await cfgView();
  ok(r.code === 0 && /our epoch #\d+ .*ended.*totalBids=0\.000000.*SettleEpoch/.test(r.out), "(a2) next run settled our expired, bid-less epoch (quote rolled over)");
  ok(/started epoch/.test(r.out) && /DONE: claimed/.test(r.out) && c.epochId === c0.epochId + 2n, `(a2) ...then started a fresh epoch from the rollover and completed it (epochId ${c0.epochId} -> ${c.epochId})`);
  ok((await tokBal(bidderUsdc)) > usdc0, `(a2) USDC received: +$${U((await tokBal(bidderUsdc)) - usdc0)}`);
  await consistent("a2");

  // ================= (a3) crash after StartEpoch, bid no longer EV+ on resume =================
  console.log("\n(a3) crash right after StartEpoch -> on resume the bid is no longer EV+ (SOL price spiked): must not bid, must not wedge");
  await accrue(8n);
  c0 = await cfgView(); usdc0 = await tokBal(bidderUsdc); const sinkA3 = await tokBal(burnSink);
  r = await keeper(["--live"], { KEEPER_CRASH_AFTER: "start" });
  ok(r.code === 1 && (await cfgView()).activeQuote > 0n && journal()?.stage === "started", "(a3) crashed after StartEpoch; epoch active + journaled");
  r = await keeper(["--live"], { SOL_PRICE_USD: "5000" });
  c = await cfgView();
  ok(r.code === 0 && /NOT bidding: bid not EV\+/.test(r.out) && /totalBids=0\.000000.*SettleEpoch/.test(r.out) && !/escrowed|started epoch/.test(r.out), "(a3) resumed run declined to bid, waited, settled the empty epoch, started nothing new (EV gate)");
  ok(c.epochId === c0.epochId + 1n && (await tokBal(bidderUsdc)) === usdc0 && (await tokBal(burnSink)) === sinkA3 && c.rollover > 0n, `(a3) nothing burned, nothing claimed, the pot rolled over ($${U(c.rollover)})`);
  await consistent("a3");

  // ================= (b1) SIGKILL after SubmitBid =================
  console.log("\n(b1) SIGKILL right after SubmitBid (leaves a stale lock) -> next run takes over, settles, claims");
  await accrue(8n);
  c0 = await cfgView(); usdc0 = await tokBal(bidderUsdc);
  r = await keeper(["--live"], { KEEPER_CRASH_AFTER: "bid", KEEPER_CRASH_HARD: "1" });
  j = journal(); c = await cfgView();
  // (tsx runs the script in a child node process: the SIGKILL surfaces as signal SIGKILL or exit 137 of the wrapper)
  const lockPid = fs.existsSync(lockPath) ? parseInt(fs.readFileSync(lockPath, "utf8"), 10) : 0;
  let lockPidDead = false; try { process.kill(lockPid, 0); } catch { lockPidDead = lockPid > 0; }
  ok((r.signal === "SIGKILL" || r.code === 137) && !/ERR injected/.test(r.out) && lockPidDead, `(b1) keeper was SIGKILLed after SubmitBid (signal=${r.signal} code=${r.code}); stale lock left behind by dead pid ${lockPid}`);
  ok(j?.stage === "bid" && !!j.bidReceipt && (await tokBal(targetEscrow)) === BigInt(j.bidAmount) && c.activeQuote > 0n, `(b1) bid of ${j?.bidAmount} lamports escrowed and journaled (stage=bid, receipt ${j?.bidReceipt})`);
  await consistent("b1 mid-flight", false);
  let sink0 = await tokBal(burnSink);
  r = await keeper(["--live"]);
  c = await cfgView();
  ok(r.code === 0 && /removed stale lock/.test(r.out), "(b1) next run detected the dead pid and removed the stale lock");
  ok(/settled epoch/.test(r.out) && /DONE: claimed/.test(r.out) && c.epochId === c0.epochId + 1n, "(b1) next run settled + claimed the journaled epoch (no extra epoch)");
  ok((await tokBal(burnSink)) - sink0 >= BigInt(j.bidAmount) && (await buf(new PublicKey(j.bidReceipt))) === null, "(b1) bid burned into the dead-sink; bid receipt closed");
  ok((await tokBal(bidderUsdc)) > usdc0, `(b1) USDC received: +$${U((await tokBal(bidderUsdc)) - usdc0)}`);
  await consistent("b1");

  // ================= (b2) crash after SubmitBid + journal lost =================
  console.log("\n(b2) crash right after SubmitBid AND the journal file is lost -> recovered from chain state alone");
  await accrue(8n);
  usdc0 = await tokBal(bidderUsdc);
  r = await keeper(["--live"], { KEEPER_CRASH_AFTER: "bid" });
  j = journal();
  ok(r.code === 1 && j?.stage === "bid", "(b2) crashed after SubmitBid");
  fs.unlinkSync(statePath);
  r = await keeper(["--live"]);
  ok(r.code === 0 && /adopting it/.test(r.out) && /settled epoch/.test(r.out) && /DONE: claimed/.test(r.out), "(b2) with NO journal the keeper found its receipt on-chain, adopted the epoch, settled + claimed");
  ok((await tokBal(bidderUsdc)) > usdc0 && (await buf(new PublicKey(j.bidReceipt))) === null, `(b2) USDC received: +$${U((await tokBal(bidderUsdc)) - usdc0)}; receipt closed`);
  await consistent("b2");

  // ================= (b3) crash after SettleEpoch =================
  console.log("\n(b3) crash right after SettleEpoch -> next run claims");
  await accrue(8n);
  usdc0 = await tokBal(bidderUsdc);
  r = await keeper(["--live"], { KEEPER_CRASH_AFTER: "settle" });
  j = journal(); c = await cfgView();
  ok(r.code === 1 && c.activeQuote === 0n && c.pending > 0n && j?.stage === "bid" && (await tokBal(bidderUsdc)) === usdc0, `(b3) crashed after SettleEpoch: epoch settled, $${U(c.pending)} pending, not yet claimed`);
  await consistent("b3 mid-flight", false);
  r = await keeper(["--live"]);
  ok(r.code === 0 && /DONE: claimed/.test(r.out) && (await tokBal(bidderUsdc)) > usdc0, `(b3) next run claimed: +$${U((await tokBal(bidderUsdc)) - usdc0)}`);
  await consistent("b3");

  // ================= (c) foreign epoch =================
  console.log("\n(c) a FOREIGN epoch (started + bid by another key) must not block the keeper");
  await accrue(8n);
  c0 = await cfgView(); usdc0 = await tokBal(bidderUsdc);
  const fEpoch = Keypair.generate(), fReceipt = Keypair.generate();
  const fWsol = await createAccount(conn, funder, NATIVE_MINT, funder.publicKey, Keypair.generate());
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: fWsol, lamports: 200_000 }), createSyncNativeInstruction(fWsol)]);
  await send([
    SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: fEpoch.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(EPOCH_SIZE), space: EPOCH_SIZE, programId: RM }),
    rewardStartEpoch(RM, { cfg, epochAcc: fEpoch.publicKey, dex, market: mkt, quoteMint: USDC, dexVault: V.vault, quoteVault, percolator: P }),
    SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: fReceipt.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(BIDDER_SIZE), space: BIDDER_SIZE, programId: RM }),
    rewardSubmitBid(RM, { cfg, epochAcc: fEpoch.publicKey, bidReceipt: fReceipt.publicKey, bidder: funder.publicKey, bidderTargetTok: fWsol, targetEscrow, targetMint: NATIVE_MINT, amount: 100_000n }),
  ], [fEpoch, fReceipt]);
  r = await keeper(["--live"]);
  ok(r.code === 0 && /foreign\/unknown epoch .* is still running .* skipping this run/.test(r.out) && !fs.existsSync(statePath) && !fs.existsSync(lockPath), "(c) while the foreign epoch is running the keeper just skips (exit 0, no journal, lock released)");
  const fe = await epochView(fEpoch.publicKey);
  ok(!fe.settled && (await cfgView()).activeQuote > 0n, "(c) foreign epoch still unsettled");
  await waitUntilSlot(fe.endSlot + 2);
  r = await keeper(["--live"]);
  c = await cfgView();
  ok(r.code === 0 && /a foreign\/unknown epoch #\d+ .*-> SettleEpoch/.test(r.out) && (await epochView(fEpoch.publicKey)).settled, "(c) keeper settled the expired foreign epoch (permissionless)");
  ok(/started epoch/.test(r.out) && /DONE: claimed/.test(r.out) && c.epochId === c0.epochId + 2n && (await tokBal(bidderUsdc)) > usdc0, `(c) ...and then ran its own epoch in the same run (epochId ${c0.epochId} -> ${c.epochId}), USDC +$${U((await tokBal(bidderUsdc)) - usdc0)}`);
  ok(c.pending === (await epochView(fEpoch.publicKey)).quotePaid && c.pending > 0n, `(c) the foreign bidder's unclaimed payout stays reserved (pendingClaims $${U(c.pending)})`);
  await consistent("c");

  // ================= (d) two concurrent invocations =================
  console.log("\n(d) two concurrent --live invocations: the second must skip via the lock");
  await accrue(8n);
  c0 = await cfgView(); usdc0 = await tokBal(bidderUsdc);
  const pa = keeper(["--live"], {}, "A");
  await sleep(3000);
  const rb = await keeper(["--live"], {}, "B");
  const ra = await pa;
  c = await cfgView();
  ok(rb.code === 0 && /another run holds the lock/.test(rb.out) && !/started epoch|SettleEpoch|escrowed|claimed/.test(rb.out), "(d) second invocation refused: 'another run holds the lock' (exit 0, sent nothing)");
  ok(ra.code === 0 && /DONE: claimed/.test(ra.out) && c.epochId === c0.epochId + 1n && (await tokBal(bidderUsdc)) > usdc0, `(d) first invocation completed exactly one epoch (epochId ${c0.epochId} -> ${c.epochId})`);
  await consistent("d");

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("KEEPER RESUME TEST OK: crash after start / bid / settle, lost journal, stale lock, foreign epoch, concurrent runs and dry-run all behave; the keeper never wedges.");
  process.exit(0);
}
main().catch(e => { console.error(mask(String((e as Error)?.stack ?? e)).slice(0, 800)); process.exit(1); });
