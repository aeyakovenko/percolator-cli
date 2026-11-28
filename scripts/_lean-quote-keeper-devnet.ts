/** DEVNET PROOF for the quote keeper (src/lean/quote-keeper.ts — the exact loop scripts/_lean-quote-keeper.ts runs).
 *  Fresh devnet market, built-in funding ON, LOADED (long/short pair), SHORT maxStaleness (150 slots ~ 1 min).
 *  The keeper runs for real (live transactions) against a SCRIPTED pair of spot sources ("coinbase", "kraken"):
 *    A calm drift            -> no price push
 *    B +25 bps jump          -> exactly 1 push, lands on spot
 *    C -64 bps jump          -> exactly 2 capped ramp-free steps
 *    C2 +90 bps jump         -> exactly 2 steps (dt rule)
 *    D total feed outage     -> no price push; liveness HOLD pushes keep the oracle alive (inside the safe-drift bound)
 *    E one-source wild print -> rejected (sources disagree), no push;  E2 both-source single wild print -> unconfirmed, no push
 *    E3 single source        -> small gap pushed (loud), large gap refused
 *    F long calm             -> liveness heartbeat pushes at 0.4 x maxStaleness
 *    (a) oracle age never exceeds 0.8 x maxStaleness across A..F
 *    G outage OUTSIDE the safe-drift bound -> keeper stops pushing, oracle goes stale, Trade reverts oracleStale (fail closed); recovers
 *    (b) keeper stopped -> stale -> Trade reverts oracleStale (106)    (c) keeper restarted -> next push -> Trade works
 *    (e) oracle key as fee payer -> 5000 lamports/push    (d) admin StartWindDown -> keeper idles
 *  Also: no push stamps lastRampSlot, conservation V == SPL (DEX + vault read in ONE getMultipleAccountsInfo).
 *  Run: LEAN_RPC_URL=<devnet rpc> npx tsx scripts/_lean-quote-keeper-devnet.ts */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, startWindDown, initPortfolio, depositCollateral, trade, refreshLeg, packFundingCfg, assertDevnet,
  deriveDexVault, parseDex, parseMarket, type MarketParams, type VaultAccounts,
  QuoteKeeper, backoffSource, maskSecrets, gapBpsOf, heartbeatAgeSlots, alarmAgeSlots, maxAllowedMove, stampsRampPending,
  type PushEvent, type SpotSource,
} from "../src/lean/index.js";

const conn = new Connection(process.env.LEAN_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (s: string) => console.log(maskSecrets(s));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|fetch failed/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
async function retry<T>(f: () => Promise<T>): Promise<T> { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 5) throw e; await sleep(600 * (i + 1)); } } }

const MAX_STALE = 150n, THR = 10, P0 = 60_000;
const e6 = (p: number) => BigInt(Math.round(p * 1e6));
const usd = (n: bigint) => (Number(n) / 1e6).toFixed(2);

// ---- the scripted spot sources (per-source, so the guard logic is what gets exercised)
const S: { cb: number | null; kr: number | null; once: { cb?: number; kr?: number } } = { cb: P0 + 1, kr: P0 - 1, once: {} };
const scripted = (name: "cb" | "kr", label: string): SpotSource => backoffSource(label, async () => {
  const w = S.once[name];
  if (w !== undefined) { delete S.once[name]; return { price: w, tsMs: Date.now(), fetchedMs: Date.now() }; }
  const p = S[name];
  if (p === null) throw new Error("scripted outage");
  return { price: p, tsMs: Date.now(), fetchedMs: Date.now() };
}, { baseMs: 300, maxMs: 300 });
const setSpot = (p: number) => { S.cb = Math.round((p + 1) * 100) / 100; S.kr = Math.round((p - 1) * 100) / 100; };
const spotE6 = () => e6(((S.cb as number) + (S.kr as number)) / 2);
const bump = (p: number, bps: number) => Math.round(p * (1 + bps / 1e4) * 100) / 100;

async function main() {
  await assertDevnet(conn);
  say(`devnet program ${P.toBase58()}`);
  // ---------------------------------------------------------------- market setup (mirrors _lean-builtin-funding.ts)
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
  const params: MarketParams = { initPrice: e6(P0), exitWindow: 10n, maxStaleness: MAX_STALE, fundingCfg, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  const tradeIxs = (qty: bigint) => [
    refreshLeg(P, { dex, market: mkt, portfolio: pL }), refreshLeg(P, { dex, market: mkt, portfolio: pS }),
    trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty }),
  ];
  await send([tradeIxs(1_000n)[2]], [oL, oS]); // 0.001 BTC long/short pair: the market is LOADED
  const read = async () => { const a = await retry(() => conn.getAccountInfoAndContext(mkt, "confirmed")); return { m: parseMarket(Buffer.from(a.value!.data)), slot: BigInt(a.context.slot) }; };
  const { m: m0 } = await read();
  ok(m0.fundingCfg === fundingCfg && m0.oiLong > 0n && m0.oiShort > 0n && m0.maxStaleness === MAX_STALE && m0.maxMoveBps === 100n,
    `market ${mkt.toBase58()} LOADED (OI ${m0.oiLong}/${m0.oiShort}), built-in funding on, maxStaleness ${m0.maxStaleness}, maxMoveBps ${m0.maxMoveBps}, mark $${usd(m0.markPrice)}`);
  const ramp0 = m0.warmupSlots; // bytes 152..159 = lastRampSlot
  say(`  lastRampSlot baseline = ${ramp0}`);

  // ---------------------------------------------------------------- the keeper (same class the daemon runs), LIVE on devnet
  const logs: string[] = [];
  const t0 = Date.now();
  const klog = (l: string) => { logs.push(l); say(`    [keeper +${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`); };
  const mkKeeper = () => new QuoteKeeper({
    conn, programId: P, market: mkt, oracle, funder, sources: [scripted("cb", "coinbase"), scripted("kr", "kraken")], log: klog,
    config: { live: true, thresholdBps: THR, pollMs: 1_000, fastPollMs: 400, minIntervalMs: 3_000, statsMs: 60_000, heartbeatFraction: 0.4, maxPushesPerHour: 120 },
  });
  let keeper = mkKeeper();
  let ac = new AbortController();
  let running = keeper.run(ac.signal);

  // independent age sampler (does not trust the keeper's own bookkeeping)
  let maxAge = 0n, sampling = true, samples = 0;
  const sampler = (async () => { while (sampling) { try { const { m, slot } = await read(); const a = slot > m.lastOracleSlot ? slot - m.lastOracleSlot : 0n; if (a > maxAge) maxAge = a; samples++; } catch { /* transient */ } await sleep(700); } })();

  const isPrice = (e: PushEvent) => e.reason === "gap" || e.reason === "gap-urgent" || e.reason === "catch-up";
  let cursor = 0;
  const since = () => { const ev = keeper.events.slice(cursor); cursor = keeper.events.length; return ev; };
  const waitMark = async (target: bigint, timeoutMs = 30_000) => { const t = Date.now(); while (Date.now() - t < timeoutMs) { if ((await read()).m.markPrice === target) return true; await sleep(400); } return false; };
  const rampOk = async (label: string, ev: PushEvent[]) => {
    const { m } = await read();
    ok(m.warmupSlots === ramp0 && ev.every(e => !e.stampsRamp && e.diff < (e.maxAllowed >> 1n || 1n)), `${label}: no push stamped lastRampSlot (on-chain ${m.warmupSlots}, steps ${ev.map(e => `${e.diff}/${e.maxAllowed}`).join(" ") || "-"})`);
  };
  const fmt = (ev: PushEvent[]) => ev.map(e => `${e.reason}@age${e.ageSlots}`).join(", ") || "none";

  // ---- A: calm drift (+-4 bps), 14 s
  say("\nA. calm drift +-4 bps");
  for (const b of [3, -4, 4, -3, 2, -4, 0]) { setSpot(bump(P0, b)); await sleep(2_000); }
  let ev = since();
  ok(ev.filter(isPrice).length === 0, `A: calm drift caused no price push (events: ${fmt(ev)})`);

  // ---- B: +25 bps
  say("\nB. +25 bps jump");
  let px = bump(P0, 25); setSpot(px);
  ok(await waitMark(spotE6()), `B: oracle reached spot $${usd(spotE6())} exactly`);
  await sleep(3_000); ev = since();
  ok(ev.filter(isPrice).length === 1 && ev.filter(isPrice)[0].reason === "gap-urgent", `B: exactly 1 price push (events: ${fmt(ev)})`);
  await rampOk("B", ev);
  const feeTx = ev[0]?.sig ? await retry(async () => { const t = await conn.getTransaction(ev[0].sig as string, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (!t) throw new Error("not yet"); return t; }) : null;
  ok(feeTx?.meta?.fee === 10_000, `B: push tx fee = ${feeTx?.meta?.fee} lamports (funder + oracle = 2 signatures), compute units ${feeTx?.meta?.computeUnitsConsumed}`);

  // ---- C: -64 bps (2 capped steps)
  say("\nC. -64 bps jump (needs 2 capped steps)");
  px = bump(px, -64); setSpot(px);
  ok(await waitMark(spotE6()), `C: oracle reached spot $${usd(spotE6())} exactly`);
  await sleep(3_000); ev = since();
  const cP = ev.filter(isPrice);
  ok(cP.length === 2 && cP[0].reason === "gap-urgent" && cP[1].reason === "catch-up", `C: exactly 2 price pushes = the minimum for 64 bps at a ~50 bps ramp-free step (events: ${fmt(ev)})`);
  ok(cP.length > 0 && cP[0].diff === (cP[0].maxAllowed >> 1n) - 1n, `C: first step is the full ramp-free step ${cP[0]?.diff} = (maxAllowed ${cP[0]?.maxAllowed} >> 1) - 1`);
  if (cP.length === 2) say(`     step slots: ${cP[0].slot} -> ${cP[1].slot} (${(cP[1].slot ?? 0) - (cP[0].slot ?? 0)} slots apart, ${cP[1].atMs - cP[0].atMs} ms)`);
  await rampOk("C", ev);

  // ---- C2: +90 bps (2 steps; the remainder does not fit a dt==1 half step)
  say("\nC2. +90 bps jump");
  px = bump(px, 90); setSpot(px);
  ok(await waitMark(spotE6()), `C2: oracle reached spot $${usd(spotE6())} exactly`);
  await sleep(3_000); ev = since();
  ok(ev.filter(isPrice).length === 2, `C2: exactly 2 price pushes (events: ${fmt(ev)})`);
  await rampOk("C2", ev);

  // ---- D: total feed outage, 34 s (> heartbeat 24 s): no price push, liveness holds at the last good spot
  say("\nD. total feed outage 34 s (inside the safe-drift bound)");
  const markD = (await read()).m.markPrice;
  S.cb = null; S.kr = null;
  await sleep(34_000);
  ev = since();
  const { m: mD, slot: sD } = await read();
  ok(ev.filter(isPrice).length === 0, `D: outage caused no price push (events: ${fmt(ev)})`);
  ok(ev.some(e => e.reason === "liveness-hold") && ev.every(e => e.price === markD) && mD.markPrice === markD, `D: liveness-hold push(es) kept the oracle alive at the last known price $${usd(markD)} (age now ${sD - mD.lastOracleSlot})`);
  await rampOk("D", ev);
  setSpot(px); await sleep(2_500); since();

  // ---- E: one source prints +300 bps for 5 s
  say("\nE. one-source wild print (+300 bps on coinbase)");
  const rej0 = { ...keeper.stats.spotRejects };
  S.cb = bump(px, 300); await sleep(5_000); setSpot(px); await sleep(2_500);
  ev = since();
  ok(ev.filter(isPrice).length === 0 && (keeper.stats.spotRejects["disagree"] ?? 0) > (rej0["disagree"] ?? 0) && (await read()).m.markPrice === markD, `E: wild print rejected (disagree x${(keeper.stats.spotRejects["disagree"] ?? 0) - (rej0["disagree"] ?? 0)}), no price push, mark unchanged (events: ${fmt(ev)})`);
  // ---- E2: both sources print +200 bps for exactly one poll
  say("\nE2. single wild print on BOTH sources (+200 bps, one poll)");
  S.once = { cb: bump(px, 200) + 1, kr: bump(px, 200) - 1 }; await sleep(4_000);
  ev = since();
  ok(ev.filter(isPrice).length === 0 && (keeper.stats.spotRejects["jump-pending"] ?? 0) > (rej0["jump-pending"] ?? 0) && (await read()).m.markPrice === markD, `E2: unconfirmed jump rejected (jump-pending), no price push (events: ${fmt(ev)})`);

  // ---- E3: single source up
  say("\nE3. only one source up: +15 bps is pushed, +60 bps is refused");
  S.kr = null; S.cb = bump(px, 15);
  ok(await waitMark(e6(S.cb)), `E3: single-source small gap pushed to $${usd(e6(S.cb))}`);
  await sleep(1_500); ev = since();
  ok(ev.filter(isPrice).length === 1 && logs.some(l => /WARNING spot SINGLE/.test(l)), `E3: exactly 1 price push, logged loudly (events: ${fmt(ev)})`);
  const markE3 = (await read()).m.markPrice;
  S.cb = bump(px, 75); await sleep(5_000); ev = since();
  ok(ev.filter(isPrice).length === 0 && (await read()).m.markPrice === markE3 && (keeper.stats.spotRejects["single-gap"] ?? 0) > 0, `E3: single-source 60 bps gap refused (single-gap), no price push (events: ${fmt(ev)})`);
  px = bump(px, 15); S.cb = px; S.kr = px; await sleep(2_500); since();

  // ---- F: long calm
  say("\nF. long calm 40 s: liveness heartbeat");
  await sleep(40_000);
  ev = since();
  const hb = heartbeatAgeSlots(MAX_STALE, 0.4), alarm = alarmAgeSlots(MAX_STALE);
  const live = keeper.events.filter(e => e.reason === "liveness" || e.reason === "liveness-hold");
  ok(ev.length >= 1 && ev.every(e => e.reason === "liveness" && e.diff === 0n), `F: ${ev.length} liveness push(es), unchanged price, no price push (events: ${fmt(ev)})`);
  ok(live.length > 0 && live.every(e => e.ageSlots >= hb && e.ageSlots < alarm), `liveness pushes fire at age >= ${hb} (0.4 x ${MAX_STALE}) and well before ${alarm}: ages ${live.map(e => e.ageSlots).join(",")}`);

  // ---- (a) availability across A..F
  sampling = false; await sampler;
  const priceTotal = keeper.events.filter(isPrice).length;
  ok(maxAge <= alarm && keeper.stats.maxAgeSlots <= alarm, `(a) oracle age never exceeded 0.8 x maxStaleness = ${alarm} slots across A..F incl. the outage: max sampled ${maxAge} (${samples} samples), keeper-observed max ${keeper.stats.maxAgeSlots}`);
  ok(keeper.health().worst === 0 && keeper.stats.unavailableMs === 0, `(a) health code stayed 0, AMM unavailable ${keeper.health().unavailableSec}s`);
  ok(priceTotal === 6, `price pushes total = ${priceTotal}, expected minimum 6 (B 1 + C 2 + C2 2 + E3 1); liveness pushes ${live.length}; send failures ${keeper.stats.sendFailures}`);
  const { m: mF } = await read();
  ok(gapBpsOf(spotE6(), mF.markPrice, mF.markPrice) < THR, `oracle within the threshold of spot at the end: mark $${usd(mF.markPrice)} spot $${usd(spotE6())} gap ${gapBpsOf(spotE6(), mF.markPrice, mF.markPrice).toFixed(2)} bps`);
  ok(mF.warmupSlots === ramp0 && keeper.events.every(e => !e.stampsRamp && !stampsRampPending(maxAllowedMove(e.mark, 100n, e.ageSlots < 2n ? 1n : e.ageSlots), e.diff)), `no push of the whole run stamped lastRampSlot (still ${mF.warmupSlots})`);

  // ---- G: outage OUTSIDE the safe-drift bound -> fail closed
  say("\nG. outage outside the safe-drift bound (kraken down, coinbase prints +150 bps): keeper must stop pushing and let the oracle go stale");
  const nG = keeper.events.length;
  S.kr = null; S.cb = bump(px, 150);
  let stale = false;
  for (let i = 0; i < 120 && !stale; i++) { await sleep(1_000); const { m, slot } = await read(); stale = slot - m.lastOracleSlot > MAX_STALE + 3n; }
  await sleep(2_000);
  ok(stale && keeper.events.length === nG, `G: keeper sent NO push while outside the drift bound; oracle went stale (fail closed)`);
  ok(keeper.health().code === 2 && keeper.stats.unavailableMs > 0 && logs.some(l => /ALARM AMM UNAVAILABLE/.test(l)) && logs.some(l => /ALARM oracle age/.test(l)), `G: health signal = ${keeper.health().code} (stale), 0.8 alarm + UNAVAILABLE alarm logged, unavailable ${keeper.health().unavailableSec}s counted`);
  const rej = async () => { try { await sendAndConfirmTransaction(conn, new Transaction().add(...tradeIxs(100n)), [funder, oL, oS], { commitment: "confirmed" }); return "succeeded"; } catch (e) { const s = maskSecrets(String(e)); return /0x6a\b/.test(s) ? "oracleStale(106)" : s.slice(0, 160); } };
  let r = await rej();
  ok(r === "oracleStale(106)", `G: bilateral Trade rejected while stale — ${r}`);
  S.cb = px; S.kr = px;
  let fresh = false;
  for (let i = 0; i < 40 && !fresh; i++) { await sleep(500); fresh = keeper.events.length > nG; }
  await send(tradeIxs(100n), [oL, oS]);
  ok(fresh && keeper.events[nG].reason === "liveness", `G: feed back -> keeper revived the oracle (${keeper.events[nG]?.reason}) and a Trade succeeds again`);

  // ---- (b) keeper stopped -> stale -> oracleStale
  say("\n(b) stop the keeper, wait past maxStaleness");
  ac.abort(); await running;
  const allEvents = [...keeper.events];
  stale = false;
  for (let i = 0; i < 150 && !stale; i++) { await sleep(1_000); const { m, slot } = await read(); stale = slot - m.lastOracleSlot > MAX_STALE + 3n; }
  r = await rej();
  ok(stale && r === "oracleStale(106)", `(b) keeper stopped, oracle age > ${MAX_STALE}: bilateral Trade rejected — ${r}`);

  // ---- (c) restart -> next push -> trading works
  say("\n(c) restart the keeper");
  keeper = mkKeeper(); ac = new AbortController(); running = keeper.run(ac.signal);
  fresh = false;
  for (let i = 0; i < 40 && !fresh; i++) { await sleep(500); fresh = keeper.events.length > 0; }
  const sig = fresh ? await send(tradeIxs(100n), [oL, oS]) : "";
  ok(fresh && sig.length > 0, `(c) restarted keeper pushed (${keeper.events[0]?.reason}, age ${keeper.events[0]?.ageSlots}) and the Trade succeeded ${sig.slice(0, 12)}…`);
  await sleep(1_500);
  ac.abort(); await running;
  allEvents.push(...keeper.events);

  // ---- (e) oracle key as its own fee payer: 1 signature = 5000 lamports per push
  say("\n(e) FEE_PAYER=oracle: the oracle key pays its own fee");
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: oracle.publicKey, lamports: 2_000_000 })]);
  const solo = new QuoteKeeper({ conn, programId: P, market: mkt, oracle, funder: oracle, sources: [scripted("cb", "coinbase"), scripted("kr", "kraken")], log: klog,
    config: { live: true, thresholdBps: THR, pollMs: 1_000, minIntervalMs: 0 } });
  setSpot(bump(px, 12));
  let soloEv: PushEvent | undefined;
  for (let i = 0; i < 20 && !soloEv; i++) { const t = await solo.tick(); if (t.kind === "push") soloEv = t.event; else await sleep(500); }
  const soloTx = soloEv?.sig ? await retry(async () => { const t = await conn.getTransaction(soloEv!.sig as string, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (!t) throw new Error("not yet"); return t; }) : null;
  ok(soloTx?.meta?.fee === 5000 && (await read()).m.markPrice === spotE6(), `(e) oracle-paid push landed (${soloEv?.reason}), fee = ${soloTx?.meta?.fee} lamports (1 signature), mark = spot $${usd(spotE6())}`);
  allEvents.push(...solo.events);

  // QK_KEEP_MARKET=<dir>: leave the market Active and write a manifest + the (throwaway, devnet-only) oracle key there,
  // so the real daemon script can be pointed at it:  LEAN_MANIFEST=<dir>/manifest.json ORACLE_KEYPAIR=<dir>/oracle.json
  const keepDir = process.env.QK_KEEP_MARKET;
  if (keepDir) {
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(`${keepDir}/manifest.json`, JSON.stringify({ network: "devnet", percolator: P.toBase58(), dex: dex.toBase58(), market: mkt.toBase58(), oracleAuth: oracle.publicKey.toBase58() }, null, 2));
    fs.writeFileSync(`${keepDir}/oracle.json`, JSON.stringify([...oracle.secretKey]), { mode: 0o600 });
    say(`\n(d) skipped: market left Active, manifest written to ${keepDir}/manifest.json`);
  } else {
    // ---- (d) WindDown: the keeper must go idle (UpdateOracle only works while Active)
    say("\n(d) admin StartWindDown: keeper must stop pushing");
    await send([startWindDown(P, { market: mkt, caller: funder.publicKey })]);
    keeper = mkKeeper();
    const idle = [await keeper.tick(), await keeper.tick(), await keeper.tick()];
    ok(idle.every(t => t.kind === "idle" && t.reason === "WindDown") && keeper.events.length === 0 && logs.some(l => /market is WindDown: not pushing/.test(l)), `(d) market WindDown -> keeper idle (${idle.map(t => t.kind + ":" + t.reason).join(", ")}), 0 pushes, logged`);
  }

  // ---- conservation: DEX + vault in ONE call
  const [dA, vA] = await retry(() => conn.getMultipleAccountsInfo([dex, V.vault], "confirmed"));
  const d = parseDex(Buffer.from(dA!.data));
  const spl = Buffer.from(vA!.data).readBigUInt64LE(64); // SPL token account: amount u64 at offset 64
  ok(d.vaultBalance === spl && spl === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards,
    `conservation V == SPL == C+I+R+S+Rew (V ${d.vaultBalance}, SPL ${spl}; one getMultipleAccountsInfo)`);
  const { m: mEnd } = await read();
  ok(mEnd.warmupSlots === ramp0 && mEnd.statusName === (keepDir ? "Active" : "WindDown"), `end state: market ${mEnd.statusName}, lastRampSlot ${mEnd.warmupSlots} (never stamped), premiumE6 ${mEnd.premiumE6}`);

  const by: Record<string, number> = {};
  for (const e of allEvents) by[e.reason] = (by[e.reason] ?? 0) + 1;
  say(`\npushes by reason: ${JSON.stringify(by)}; total ${allEvents.length}`);
  say(`${pass} passed, ${fail.length} failed${fail.length ? "\nFAILURES:\n - " + fail.join("\n - ") : "\nQUOTE KEEPER DEVNET PROOF OK"}`);
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error(maskSecrets(String(e)).slice(0, 600)); process.exit(1); });
