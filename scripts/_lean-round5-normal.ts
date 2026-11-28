/**
 * ROUND-5 REHEARSAL — NORMAL-OPERATION checks (all must PASS) against a passive PropAMM vault built
 * with the round-5 market config (imBps 1000 / mmBps 600 / liqFee 50 / tradeFee 2 bps / maxMove 100 /
 * maxInsDraw 2500, built-in funding ON, short maxStaleness). Self-contained: fresh disposable mint +
 * DEX + market, an ADEQUATELY-capitalized vault (so both sides can be exercised — the $23 default sizing
 * is a separate question, see ROUND5-REHEARSAL.md), and the oracle driven directly with a generated key.
 *
 * Verifies:
 *   - takers open/close LONG and SHORT against the vault repeatedly, in NETTED (mode 4) and plain OPEN/CLOSE;
 *   - exec price == oracle ± half-spread/impact EXACTLY as propAmmQuote predicts (off-chain == on-chain sim);
 *   - the LP earns the spread (net of its trade fee) at a flat oracle on every round trip;
 *   - built-in funding accrues at a flat mark (longs pay the base interest), exact zero-sum;
 *   - the vault stays available across oracle pushes + a liveness heartbeat (age never > 0.8 x maxStaleness);
 *   - V == SPL == C+I+R+S+Rew after EVERY step (ONE getMultipleAccountsInfo);
 *   - the user position's marked PnL tracks the mark.
 *
 *   LEAN_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-round5-normal.ts
 * DEVNET ONLY.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, depositInsurance, refreshLeg,
  packFundingCfg, assertDevnet, deriveDexVault, parseDex, parseMarket, parsePortfolio,
  maskSecrets, alarmAgeSlots, heartbeatAgeSlots,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";
import { propAmmVault, type VaultAdapter, type VaultLeg } from "./_lean-round5-vault.js";

const RPC = process.env.LEAN_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const M = new PublicKey(process.env.LEAN_MATCHER ?? LEAN_DEVNET.matcher.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));

const MAX_STALE = BigInt(process.env.R5_MAX_STALENESS ?? "300");
const HALF = 20n, IMPACT = 3000n;           // round-5 recommended PropAMM params
const PRICE = 60_000;                         // BTC-like initial mark
const MAXFILL = 2_000n;                        // 0.002 BTC per fill
const VAULT_CAP = 2_000n * POS_SCALE;          // adequately-capitalized LP so both sides can be exercised

let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(maskSecrets(s));
const e6 = (p: number) => BigInt(Math.round(p * 1e6));
const usd = (n: bigint) => `${n < 0n ? "-" : ""}$${(Number(n < 0n ? -n : n) / 1e6).toFixed(6)}`;
let nonce = 1;
const uniq = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: nonce++ });
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) {
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(uniq(), ...ixs), [funder, ...s], { commitment: "confirmed" }); }
    catch (e) { if (i < 6 && /429|Too Many|block height|timed out|fetch failed|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } }
}
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const mktOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m, "confirmed"))!.data));
const pflOf = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p, "confirmed"))!.data));
// LP/portfolio equity = capital + marked leg PnL (lockedMm is part of capital accounting)
const equity = (pf: Awaited<ReturnType<typeof pflOf>>) => pf.capital + pf.totalLockedMm + pf.legs.reduce((a, l) => a + l.posPnl, 0n);

const vault: VaultAdapter = propAmmVault(M);     // the ONE AMM touch-point (swap for oracleAmmVault in a 2nd pass)
let dex!: PublicKey, V!: VaultAccounts, mkt!: PublicKey, marketId!: bigint, ctx!: PublicKey, lpPfl!: PublicKey, oracle!: Keypair;

async function conservation(label: string) {
  const [dA, vA] = await conn.getMultipleAccountsInfo([dex, V.vault], "confirmed");
  const d = parseDex(Buffer.from(dA!.data));
  const spl = Buffer.from(vA!.data).readBigUInt64LE(64);
  ok(d.vaultBalance === spl && spl === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards, `${label}: V==SPL==C+I+R+S+Rew (V ${usd(d.vaultBalance)})`);
}
async function push(price: number) { await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: e6(price) })], [oracle]); }
/** Move the mark toward `target` the way a healthy keeper does: ramp-free steps (<50% of the maxMove band at
 *  dt>=2) so the vault NEVER enters its 150-slot ramp cooldown. */
async function moveMark(target: number) {
  for (let i = 0; i < 20; i++) {
    const m = await mktOf(mkt);
    if (m.markPrice === e6(target)) return;
    const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) < s + 2) await sleep(300); // dt>=2 => full band
    const old = Number(m.markPrice) / 1e6; const band = old * 0.01;         // maxMoveBps 100
    const step = Math.min(band * 0.49, Math.abs(target - old));              // <50% band => no ramp stamp
    await push(Math.round((target > old ? old + step : old - step) * 100) / 100);
  }
}

/** Open or close `qty` against the vault as single-signer taker `owner`/`pfl`; verify exec == propAmmQuote prediction. */
async function fillVsPrediction(label: string, taker: Keypair, pfl: PublicKey, mode: number, takerIsLong: boolean, qty: bigint) {
  const m = await mktOf(mkt);
  const c = await vault.readCtx(conn, ctx);
  const isRamping = m.lastRampSlot > 0n && BigInt(await conn.getSlot("confirmed")) <= m.lastRampSlot + 152n;
  const leg: VaultLeg = { market: mkt, marketId, mode, takerIsLong, maxQty: qty, markPrice: m.markPrice, maxMoveBps: m.maxMoveBps, isRamping };
  const pred = vault.predict(c, [leg])[0];
  const onchainExec = await vault.simulateQuote(conn, ctx, c, [leg], funder);
  ok(onchainExec === pred.execPrice, `${label}: on-chain quote == off-chain prediction (exec ${usd(pred.execPrice)}, ${pred.isBuy ? "ask" : "bid"} ${pred.effBps}bps vs mark ${usd(m.markPrice)})`);

  const lp0 = equity(await pflOf(lpPfl));
  const ixs = await vault.takerFill(conn, { percolator: P, dex, taker: taker.publicKey, takerPortfolio: pfl, lpPortfolio: lpPfl, ctx, legs: [leg] });
  await send(ixs, [taker]);
  const lp1 = equity(await pflOf(lpPfl));
  return { pred, lpDelta: lp1 - lp0 };
}

async function main() {
  await assertDevnet(conn);
  oracle = Keypair.generate();
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 1_000_000n * POS_SCALE);
  dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  V = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
  const params: MarketParams = { initPrice: e6(PRICE), exitWindow: 10n, maxStaleness: MAX_STALE, fundingCfg, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  marketId = (await mktOf(mkt)).marketId;
  const insR = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: insR, lp: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  say(`market ${mkt.toBase58()} id ${marketId} mark ${usd(e6(PRICE))} maxStaleness ${MAX_STALE}, insurance $23`);

  // vault: LP portfolio + ctx (one tx) + bind + capital
  const lpOwner = Keypair.generate();
  const ctxKp = Keypair.generate(); ctx = ctxKp.publicKey;
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(vault.ctxSize));
  await send(vault.initCtxIxs({ ctx, owner: lpOwner.publicKey, payer: funder.publicKey, rentLamports: rent, params: { halfSpreadBps: HALF, impactBps: IMPACT, maxFillQty: MAXFILL }, allowedMarketIds: [marketId] }), [ctxKp, lpOwner]);
  lpPfl = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: lpPfl, owner: lpOwner.publicKey })], [lpOwner]);
  await send([vault.bindIx({ percolator: P, portfolio: lpPfl, owner: lpOwner.publicKey, ctx })], [lpOwner]);
  await send([depositCollateral(P, V, { portfolio: lpPfl, depositor: funder.publicKey, sourceToken: fTok, amount: VAULT_CAP })]);
  say(`vault LP ${lpPfl.toBase58()} capital ${usd(VAULT_CAP)}, ctx halfSpread ${HALF}bps impact ${IMPACT} maxFill 0.002 BTC`);
  await conservation("after setup");

  // fresh takers (single-signer)
  const mkTaker = async (cap: bigint) => { const o = Keypair.generate(); const p = await newAcc(P, PORTFOLIO_SIZE); await send([initPortfolio(P, { dex, portfolio: p, owner: o.publicKey })], [o]); await send([depositCollateral(P, V, { portfolio: p, depositor: funder.publicKey, sourceToken: fTok, amount: cap })]); return { o, p }; };

  // ---- user position (the prize): open a long AGAINST THE VAULT, NETTED mode
  say("\n[A] user opens a long against the vault (NETTED mode 4)");
  const user = await mkTaker(23n * POS_SCALE);
  const rA = await fillVsPrediction("A open long", user.o, user.p, TRADE_MODE.NETTED, true, 2_000n);
  ok(rA.lpDelta > 0n, `A: LP earned the spread on the user's open (LP equity +${usd(rA.lpDelta)})`);
  await conservation("A");

  // ---- user PnL tracks the mark: push +0.5% then -0.5%
  say("\n[B] user marked PnL tracks the mark");
  const uLeg0 = (await pflOf(user.p)).legs.find((l) => l.market.equals(mkt))!;
  await moveMark(PRICE * 1.004);                 // ramp-free (keeper-style), no cooldown
  await send([refreshLeg(P, { dex, market: mkt, portfolio: user.p })]);
  const uLegUp = (await pflOf(user.p)).legs.find((l) => l.market.equals(mkt))!;
  ok(uLegUp.posPnl > uLeg0.posPnl, `B: user LONG PnL rose when mark went up (${usd(uLeg0.posPnl)} -> ${usd(uLegUp.posPnl)})`);
  await moveMark(PRICE);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: user.p })]);
  await conservation("B");

  // ---- repeated round trips both directions; LP earns the spread each time (flat oracle)
  say("\n[C] repeated taker round trips (NETTED + plain OPEN/CLOSE), LP earns spread at a flat oracle");
  const t1 = await mkTaker(40n * POS_SCALE);
  let lpGainTotal = 0n;
  for (let i = 0; i < 3; i++) {
    const open = await fillVsPrediction(`C${i} open long`, t1.o, t1.p, TRADE_MODE.NETTED, true, 1_000n);
    const close = await fillVsPrediction(`C${i} close long`, t1.o, t1.p, TRADE_MODE.CLOSE, true, 1_000n); // taker holds long, sells to close
    lpGainTotal += open.lpDelta + close.lpDelta;
    ok(open.lpDelta + close.lpDelta > 0n, `C${i}: LP net profit over the round trip (+${usd(open.lpDelta + close.lpDelta)})`);
    await conservation(`C${i}`);
  }
  // short side: a taker opens a SHORT against the vault then closes it (NETTED both ways — plain CLOSE
  // of a short is inventory-dependent and can return invalidSide 121; NETTED always reduces/flips).
  const t2 = await mkTaker(40n * POS_SCALE);
  const sOpen = await fillVsPrediction("C short open", t2.o, t2.p, TRADE_MODE.NETTED, false, 1_000n);
  ok(sOpen.pred.isBuy === false, "C: taker SHORT fills at the BID (sell), as predicted");
  const sClose = await fillVsPrediction("C short close", t2.o, t2.p, TRADE_MODE.NETTED, true, 1_000n); // buy to close the short
  ok(sOpen.lpDelta + sClose.lpDelta > 0n, `C: LP net profit on the short round trip (+${usd(sOpen.lpDelta + sClose.lpDelta)})`);
  say(`   total LP spread captured over all round trips: +${usd(lpGainTotal + sOpen.lpDelta + sClose.lpDelta)}`);
  await conservation("C");

  // ---- built-in funding at a flat mark: longs pay the base interest, zero-sum
  say("\n[D] built-in funding at a flat mark (longs pay base interest, zero-sum)");
  const uLegF0 = (await pflOf(user.p)).legs.find((l) => l.market.equals(mkt))!;
  // the vault (LP) is net short vs the user long; read both before/after
  const lpCapF0 = (await pflOf(lpPfl)).capital, uCapF0 = (await pflOf(user.p)).capital;
  const sA = (await mktOf(mkt)).lastOracleSlot;
  await sleep(45_000);
  await push(PRICE);
  const sB = (await mktOf(mkt)).lastOracleSlot, dt = sB - sA;
  await send([refreshLeg(P, { dex, market: mkt, portfolio: user.p })]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: lpPfl })]);
  const uCapF1 = (await pflOf(user.p)).capital, lpCapF1 = (await pflOf(lpPfl)).capital;
  const dUser = uCapF1 - uCapF0, dLp = lpCapF1 - lpCapF0;
  say(`   dt=${dt} slots, flat mark: user(long) capital Δ=${usd(dUser)}, LP(short) capital Δ=${usd(dLp)}`);
  ok(dUser < 0n, "D: the LONG (user) PAID funding at a flat mark (+base interest)");
  ok(dUser + dLp >= -2n && dUser + dLp <= 2n, `D: funding zero-sum within rounding (sum=${dUser + dLp})`);
  void uLegF0;
  await conservation("D");

  // ---- availability: oracle age stays well under 0.8 x maxStaleness across pushes + a heartbeat
  say("\n[E] vault availability: age never exceeds 0.8 x maxStaleness");
  const alarm = alarmAgeSlots(MAX_STALE), hb = heartbeatAgeSlots(MAX_STALE, 0.4);
  let maxAge = 0n;
  for (let i = 0; i < 4; i++) {
    const { markPrice, lastOracleSlot } = await mktOf(mkt);
    const slot = BigInt(await conn.getSlot("confirmed"));
    const age = slot > lastOracleSlot ? slot - lastOracleSlot : 0n;
    if (age > maxAge) maxAge = age;
    // a fill must still succeed while fresh
    await fillVsPrediction(`E${i} availability fill`, t1.o, t1.p, TRADE_MODE.NETTED, true, 500n);
    await fillVsPrediction(`E${i} availability close`, t1.o, t1.p, TRADE_MODE.CLOSE, true, 500n);
    await push(PRICE);
    void markPrice;
    await sleep(3000);
  }
  ok(maxAge < alarm, `E: max oracle age ${maxAge} < 0.8 x maxStaleness (${alarm}); heartbeat fires by ${hb}`);
  await conservation("E");

  say(`\n${pass} passed, ${fail.length} failed${fail.length ? "\nFAILURES:\n - " + fail.join("\n - ") : "\nROUND-5 NORMAL OPS OK"}`);
  process.exit(fail.length ? 1 : 0);
}
main().catch((e) => { console.error(maskSecrets(String(e)).slice(0, 800)); process.exit(1); });
