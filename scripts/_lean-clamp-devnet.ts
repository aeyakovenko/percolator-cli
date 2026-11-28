/** DEVNET proof for src/lean/oracle-clamp.ts against the deployed program (9b45ad1, built-in funding ON,
 *  LOADED market so the clamp branch — not the empty-market fast-snap — is exercised):
 *   - exact boundary: mark ± maxAllowedMove accepted, ± (maxAllowed + 1) rejected with oracleClamp (0x68);
 *   - the OLD keeper formula mark*99/100 is rejected at a non-divisible mark;
 *   - keeper clampPush with a far target moves exactly (maxAllowed >> 1) - 1 and does NOT stamp lastRampSlot;

 *     NOTE: the ramp-threshold assertions below encode the percolator-lean 9b45ad1 rule (75%). Percolator-lean >= 887ba02 stamps at >= 50%
 *     (inclusive), so those assertions are EXPECTED to differ there; the keeper-step assertions hold on both.
 *     the 9b45ad1 ramp threshold is maxAllowed - (maxAllowed >> 2) (75%): one below does not stamp, exactly it does;
 *   - best-effort dt == 1: half step accepted, half step + 1 rejected;
 *   - prize-monitor: opening a position moves capital -> totalLockedMm; old key changes, new key does not.
 *  Writes a manifest + throwaway oracle keypair into OUT_DIR so scripts/_lean-r4-crank.ts and
 *  scripts/_lean-oi-monitor.ts can be pointed at this devnet market (LEAN_MANIFEST / ORACLE_KEYPAIR / LEAN_RPC_URL).
 *  Usage: SOLANA_RPC_URL=<devnet rpc> OUT_DIR=<dir> npx tsx scripts/_lean-clamp-devnet.ts */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE, MAX_PRICE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, trade, packFundingCfg,
  deriveDexVault, parseMarket, parsePortfolio, assertDevnet, clampPush, maxAllowedMove, keeperStepCap, stampsRamp, stampsRampPending, decodePrizeSnapshot,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = LEAN_DEVNET.percolator;
const OUT = process.env.OUT_DIR;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const mask = (s: string) => s.replace(/api-key=[^&\s"']+/g, "api-key=***");
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }

async function main() {
  await assertDevnet(conn);
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
  // initPrice deliberately NOT divisible: 123_456_789 * 100 / 10000 = 1_234_567.89 -> floor matters
  const params: MarketParams = { initPrice: 123_456_789n, exitWindow: 10n, maxStaleness: 9000n, fundingCfg, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const M = async () => parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  if (OUT) {
    fs.writeFileSync(`${OUT}/clamp-devnet-oracle.json`, JSON.stringify(Array.from(oracle.secretKey)));
    fs.writeFileSync(`${OUT}/clamp-devnet-manifest.json`, JSON.stringify({ network: "devnet", commit: "9b45ad1", percolator: P.toBase58(), dex: dex.toBase58(), market: mkt.toBase58(), oracleAuth: oracle.publicKey.toBase58(), prizes: { insurance: mkt.toBase58(), vaultPortfolio: pS.toBase58(), userLong: pL.toBase58() } }, null, 2));
  }
  console.log(`devnet market ${mkt.toBase58()} (program ${P.toBase58()}) fundingCfg=${fundingCfg} maxMoveBps=${params.maxMoveBps}`);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100_005_000n })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100_005_000n })]);

  // ---- prize-monitor before/after: open a position (free capital -> locked margin)
  const snap = async () => {
    const infos = await conn.getMultipleAccountsInfo([mkt, pS, pL], "confirmed");
    const cap = (i: number) => infos[i] ? Buffer.from(infos[i]!.data).readBigUInt64LE(88) / 10_000n : -1n;
    return { s: decodePrizeSnapshot(P, infos), oldKey: `${cap(1)}|${cap(2)}`, long: parsePortfolio(Buffer.from(infos[2]!.data)) };
  };
  const s0 = await snap();
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE / 10n })], [oL, oS]);
  const s1 = await snap();
  console.log(`[monitor] flat : capital=${s0.long.capital} lockedMm=${s0.long.totalLockedMm}  oldKey=${s0.oldKey}  ${s0.s.line}`);
  console.log(`[monitor] open : capital=${s1.long.capital} lockedMm=${s1.long.totalLockedMm}  oldKey=${s1.oldKey}  ${s1.s.line}`);
  ok(s1.long.totalLockedMm > 0n && s1.long.capital < s0.long.capital, `opening the long moved collateral free -> locked (lockedMm ${s1.long.totalLockedMm}; total moved only by the trade fee: ${s0.s.userLong.value - s1.s.userLong.value})`);
  ok(s0.oldKey !== s1.oldKey, `OLD monitor key (free capital only) changed on open: ${s0.oldKey} -> ${s1.oldKey} (false alert)`);
  ok(s0.s.key === s1.s.key && s1.s.problems.length === 0, `NEW monitor key (capital + lockedMm) unchanged on open: ${s1.s.key}`);
  const wrongProg = decodePrizeSnapshot(LEAN_DEVNET.matcher, await conn.getMultipleAccountsInfo([mkt, pS, pL], "confirmed"));
  ok(wrongProg.problems.length === 3, `validation: same accounts vs a wrong program id -> ${wrongProg.line.slice(0, 150)}…`);

  // ---- oracle clamp
  const m0 = await M();
  ok(m0.oiLong > 0n && m0.fundingCfg === fundingCfg && m0.maxMoveBps === 100n, `market is LOADED (oi=${m0.oiLong}) with built-in funding; maxMoveBps read from account = ${m0.maxMoveBps}`);
  const bps = m0.maxMoveBps;
  /** wait until confirmed slot >= lastOracleSlot + 2, so the next push lands at dt >= 3 (full step) */
  const settle = async () => { const m = await M(); for (;;) { const s = BigInt(await conn.getSlot("confirmed")); if (s >= m.lastOracleSlot + 2n) return { m, dtLower: s - m.lastOracleSlot }; await sleep(400); } };
  const push = async (price: bigint): Promise<"ok" | string> => {
    try { await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price })], [oracle]); return "ok"; }
    catch (e) { const s = String(e); const c = s.match(/custom program error: (0x[0-9a-f]+)/); return c ? c[1] : mask(s).slice(0, 120); }
  };

  { // 1. exact boundary UP
    const { m } = await settle(); const ma = maxAllowedMove(m.markPrice, bps, 2n);
    const r1 = await push(m.markPrice + ma + 1n);
    ok(r1 === "0x68", `UP   mark ${m.markPrice} + (maxAllowed ${ma} + 1) rejected oracleClamp — ${r1}`);
    const r2 = await push(m.markPrice + ma); const a = await M();
    ok(r2 === "ok" && a.markPrice === m.markPrice + ma, `UP   mark ${m.markPrice} + maxAllowed ${ma} = ${m.markPrice + ma} ACCEPTED (exact largest move) — ${r2}`);
    ok(a.warmupSlots === a.lastOracleSlot, `     a 100% move stamps lastRampSlot (${a.warmupSlots} == lastOracleSlot)`);
  }
  { // 2. exact boundary DOWN (+ the old keeper formula)
    const { m } = await settle(); const ma = maxAllowedMove(m.markPrice, bps, 2n);
    const oldDn = (m.markPrice * 99n) / 100n, oldDiff = m.markPrice - oldDn;
    if (oldDiff > ma) { const r0 = await push(oldDn); ok(r0 === "0x68", `DOWN OLD keeper clamp mark*99/100 = ${oldDn} (diff ${oldDiff} > maxAllowed ${ma}) REJECTED oracleClamp — ${r0}`); }
    else console.log(`  - old formula not off-by-one at mark ${m.markPrice} (diff ${oldDiff} <= ${ma}); skipped`);
    const r1 = await push(m.markPrice - ma - 1n);
    ok(r1 === "0x68", `DOWN mark ${m.markPrice} - (maxAllowed ${ma} + 1) rejected oracleClamp — ${r1}`);
    const r2 = await push(m.markPrice - ma); const a = await M();
    ok(r2 === "ok" && a.markPrice === m.markPrice - ma, `DOWN mark ${m.markPrice} - maxAllowed ${ma} = ${m.markPrice - ma} ACCEPTED (exact largest move) — ${r2}`);
  }
  for (const [name, target] of [["UP", MAX_PRICE], ["DOWN", 1n]] as const) { // 3/4. keeper clamp, target far away
    const { m, dtLower } = await settle(); const ma = maxAllowedMove(m.markPrice, bps, dtLower);
    const p = clampPush(m.markPrice, target, bps, dtLower), diff = p > m.markPrice ? p - m.markPrice : m.markPrice - p;
    const r = await push(p); const a = await M();
    ok(diff === (ma >> 1n) - 1n && diff === keeperStepCap(ma), `KEEPER ${name} far target ${target}: step ${diff} == (maxAllowed ${ma} >> 1) - 1`);
    ok(r === "ok" && a.markPrice === p, `KEEPER ${name} push ${m.markPrice} -> ${p} accepted, on-chain mark == pushed — ${r}`);
    ok(a.warmupSlots === m.warmupSlots && a.warmupSlots !== a.lastOracleSlot, `KEEPER ${name} did NOT stamp lastRampSlot (still ${a.warmupSlots}, push landed at ${a.lastOracleSlot})`);
  }
  { // 5. deployed ramp threshold = maxAllowed - (maxAllowed >> 2): one below does not stamp, exactly it does
    let { m } = await settle(); let ma = maxAllowedMove(m.markPrice, bps, 2n), th = ma - (ma >> 2n);
    let r = await push(m.markPrice + (ma >> 1n)); let a = await M();
    ok(r === "ok" && a.warmupSlots === m.warmupSlots && !stampsRamp(ma, ma >> 1n), `diff == maxAllowed >> 1 (${ma >> 1n}) does NOT stamp on deployed 9b45ad1 (would under the pending 50% rule: ${stampsRampPending(ma, ma >> 1n)})`);
    ({ m } = await settle()); ma = maxAllowedMove(m.markPrice, bps, 2n); th = ma - (ma >> 2n);
    r = await push(m.markPrice - (th - 1n)); a = await M();
    ok(r === "ok" && a.warmupSlots === m.warmupSlots && !stampsRamp(ma, th - 1n), `diff == threshold - 1 (${th - 1n} of ${ma}) does NOT stamp lastRampSlot (still ${a.warmupSlots})`);
    ({ m } = await settle()); ma = maxAllowedMove(m.markPrice, bps, 2n); th = ma - (ma >> 2n);
    r = await push(m.markPrice + th); a = await M();
    ok(r === "ok" && a.warmupSlots === a.lastOracleSlot && a.warmupSlots !== m.warmupSlots && stampsRamp(ma, th), `diff == threshold (${th} = maxAllowed ${ma} - maxAllowed>>2) DOES stamp lastRampSlot (${m.warmupSlots} -> ${a.warmupSlots})`);
  }
  { // 6. near target is pushed exactly
    const { m, dtLower } = await settle();
    const p = clampPush(m.markPrice, m.markPrice - 7n, bps, dtLower); const r = await push(p); const a = await M();
    ok(p === m.markPrice - 7n && r === "ok" && a.markPrice === p, `near target (mark - 7) pushed exactly: ${m.markPrice} -> ${a.markPrice}`);
  }

  // 7. dt == 1 (best effort): tx A = unchanged price, tx B right behind it. B = mark + half (+1).
  const raw = async (price: bigint) => {
    const tx = new Transaction().add(updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price }));
    const bh = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash; tx.feePayer = funder.publicKey; tx.sign(funder, oracle);
    return { wire: tx.serialize(), bh };
  };
  const landed = async (sig: string, bh: { blockhash: string; lastValidBlockHeight: number }) => {
    try { await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed"); } catch { /* fall through to getTransaction */ }
    for (let i = 0; i < 20; i++) { const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (t) return { slot: BigInt(t.slot), err: t.meta?.err ? JSON.stringify(t.meta.err) : null }; await sleep(500); }
    return null;
  };
  const got: Record<string, string> = {};
  for (let attempt = 0; attempt < 24 && !(got.half && got.over); attempt++) {
    const which = !got.over && (attempt % 2 === 0 || got.half) ? "over" : "half";
    const { m } = await settle();
    const half = maxAllowedMove(m.markPrice, bps, 1n), full = maxAllowedMove(m.markPrice, bps, 2n);
    const bPrice = m.markPrice + half + (which === "over" ? 1n : 0n);
    const A = await raw(m.markPrice), B = await raw(bPrice);
    const sigA = await conn.sendRawTransaction(A.wire, { skipPreflight: true, maxRetries: 0 });
    await sleep(150 + 60 * (attempt % 6));
    const sigB = await conn.sendRawTransaction(B.wire, { skipPreflight: true, maxRetries: 0 });
    const [ra, rb] = await Promise.all([landed(sigA, A.bh), landed(sigB, B.bh)]);
    if (!ra || !rb || ra.err) { console.log(`  - dt==1 attempt ${attempt}: A/B not both landed cleanly (A=${JSON.stringify(ra?.err ?? "missing")}); retry`); continue; }
    const dt = rb.slot - ra.slot;
    console.log(`  - dt==1 attempt ${attempt} (${which}): A slot ${ra.slot}, B slot ${rb.slot} (dt=${dt}), B err=${rb.err}`);
    if (dt !== 1n) continue;
    if (which === "over") got.over = rb.err && rb.err.includes("104") ? `mark ${m.markPrice} + half ${half} + 1 (<= full ${full}) at dt==1 REJECTED oracleClamp (Custom 104)` : `UNEXPECTED: ${rb.err}`;
    else got.half = rb.err === null ? `mark ${m.markPrice} + half ${half} at dt==1 ACCEPTED` : `UNEXPECTED: ${rb.err}`;
  }
  if (got.over) ok(!got.over.startsWith("UNEXPECTED"), `dt==1: ${got.over}`); else console.log("  ? dt==1 half+1 rejection NOT observed (never landed exactly 1 slot apart) — UNVERIFIED on devnet");
  if (got.half) ok(!got.half.startsWith("UNEXPECTED"), `dt==1: ${got.half}`); else console.log("  ? dt==1 half acceptance NOT observed (never landed exactly 1 slot apart) — UNVERIFIED on devnet");

  console.log(`\n${pass} passed, ${fail.length} failed${fail.length ? "\nFAILURES:\n - " + fail.join("\n - ") : ""}`);
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error(mask(String(e)).slice(0, 600)); process.exit(1); });
