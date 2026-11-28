/**
 * DEVNET PROOF: drive the PropAMM passive vault (percolator-lean 887ba02, Percolator/Matcher.lean) end to end
 * with the src/lean client — real transactions on a fresh mint + DEX + 3 markets.
 *
 *   SOLANA_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-propamm-devnet.ts
 *
 * What it proves (every taker trade is signed by the TAKER ONLY — the LP owner never signs a trade):
 *   - InitPropAmm / UpdatePropAmm / SetPortfolioMatcher / TradeWithMatcher (k=1 and k=2 basket) byte layouts;
 *   - buyers fill at Ask >= mark, sellers at Bid <= mark, exactly propAmmQuote() (half-spread + impact, hedged
 *     basket = half-spread halved), also cross-checked against a simulated raw PropAmmQuote;
 *   - open long / open short / close both, repeated, in OPEN/CLOSE and NETTED modes; LP P&L per round trip;
 *   - limit-price rejection (130), maxFillQty CLAMP (partial fill, not a reject), pause (200) + unpause,
 *     market outside the immutable allowlist (201), non-owner update/bind (111), wrong/unbound ctx (131),
 *     stale other-leg (122) fixed by withLegRefresh / tradeWithMatcherFresh, ramp-cooldown unavailability (200);
 *   - "keep the AMM not stale": oracle older than maxStaleness ⇒ oracleStale (106), a fresh UpdateOracle push
 *     restores trading, and the next fill is priced off the NEW mark;
 *   - ClaimReward (op 21) and SweepSurplus (op 20, after resolving a market so its orphan insurance becomes S);
 *   - conservation V == SPL == C+I+R+S+Rew (+ full checkDexInvariants) after EVERY step, DEX + vault + every
 *     market/portfolio read in ONE getMultipleAccountsInfo call (same slot).
 * Refuses to run against anything but devnet.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, PROP_CTX_SIZE, POS_SCALE, BPS_DEN, TRADE_MODE, leanErrorName,
  assertDevnet, initDex, createMarket, updateOracle, initPortfolio, depositCollateral, withdrawCollateral, packFundingCfg,
  deriveDexVault, parseDex, parseMarket, parsePortfolio, parsePropAmmCtx, propAmmQuote, accountKind, checkDexInvariants,
  propAmmInit, propAmmUpdate, propAmmQuoteIx, setPortfolioMatcher, tradeWithMatcher, matcherLegIsBuy, sweepSurplus,
  claimReward, withLegRefresh, tradeWithMatcherFresh, refreshLeg, startWindDown, resolveMarket, parseRewardCfg, parseEpochState, parseBidReceipt,
  type MarketParams, type VaultAccounts, type MatcherLeg, type Market, type Portfolio, type PropAmmCtx, type Dex,
} from "../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
// env overrides (defaults unchanged) so the battery can run against another deployment (e.g. an upgrade rehearsal)
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58()), M = new PublicKey(process.env.LEAN_MATCHER ?? LEAN_DEVNET.matcher.toBase58());
const ORACLE_ADAPTER = new PublicKey(process.env.LEAN_ORACLE_ADAPTER ?? LEAN_DEVNET.oracleAdapter.toBase58()), REWARD_MODULE = new PublicKey(process.env.LEAN_REWARD_MODULE ?? LEAN_DEVNET.rewardModule.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const mask = (s: string) => s.replace(/api-key=[^&"'\s]+/g, "api-key=***");

let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const U = (x: bigint) => `${x < 0n ? "-" : ""}${(x < 0n ? -x : x) / POS_SCALE}.${((x < 0n ? -x : x) % POS_SCALE).toString().padStart(6, "0")}`;
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
/** Unique no-op per transaction so two otherwise identical txs (same blockhash) never share a signature ("AlreadyProcessed"). */
let nonce = 1;
const uniq = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: nonce++ });
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Slot of the last transaction this script landed: snapshots must not be served from an older slot (RPC read lag). */
let lastTxSlot = 0;
/** Wait until the cluster is `n` slots past our last transaction (so a simulation cannot run in that same slot). */
async function pastLastTx(n = 2) { while ((await conn.getSlot("confirmed")) < lastTxSlot + n) await sleep(400); }
/** Send with `payer` as fee payer + first signer. Returns the number of signatures the transaction carried. */
async function send(payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<number> {
  for (let i = 0; ; i++) {
    try {
      const tx = new Transaction().add(uniq(), ...ixs);
      const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
      for (let j = 0; j < 30; j++) { // the status RPC can lag the confirmation: insist on the real landing slot
        const st = await conn.getSignatureStatus(sig);
        if (st.value?.slot) { lastTxSlot = Math.max(lastTxSlot, st.value.slot); break; }
        await sleep(300);
      }
      return tx.signatures.length;
    } catch (e) {
      if (i < 6 && /429|Too Many|block height|Blockhash not found|timed out|fetch failed/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(mask(String((e as Error).message ?? e)));
    }
  }
}
/** Simulate (signatures verified) and assert the LAST instruction fails with the given custom code / builtin error name. */
async function expectErr(label: string, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[], want: number | string, afterSlot = 0) {
  const tx = new Transaction().add(uniq(), ...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, ...signers);
  // Leg freshness is per SLOT: a simulation that runs in the very slot our last tx landed in would see those legs
  // as "fresh". Only accept a simulation executed in a strictly later slot.
  let sim = await conn.simulateTransaction(tx);
  for (let i = 0; i < 60 && sim.context.slot <= Math.max(lastTxSlot, afterSlot) + 1; i++) { await sleep(400); sim = await conn.simulateTransaction(tx); }
  const err = sim.value.err as any;
  const idx = err?.InstructionError?.[0], body = err?.InstructionError?.[1];
  const got = typeof body === "object" && body ? body.Custom : body;
  const wantName = typeof want === "number" ? `${leanErrorName(want)}(${want})` : want;
  ok(got === want && idx === ixs.length, `${label} → rejected with ${wantName} [got ${got === undefined ? JSON.stringify(err) : typeof got === "number" ? `${leanErrorName(got)}(${got})` : got} at ix ${idx}]`);
}
/** Simulate (in a slot strictly after our last tx) and assert the whole transaction SUCCEEDS. */
async function expectOk(label: string, payer: Keypair, ixs: TransactionInstruction[], afterSlot = 0) {
  const tx = new Transaction().add(uniq(), ...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer);
  let sim = await conn.simulateTransaction(tx);
  for (let i = 0; i < 60 && sim.context.slot <= Math.max(lastTxSlot, afterSlot) + 1; i++) { await sleep(400); sim = await conn.simulateTransaction(tx); }
  ok(sim.value.err === null, `${label} → would SUCCEED (simulated at slot ${sim.context.slot})${sim.value.err ? " [got " + JSON.stringify(sim.value.err) + "]" : ""}`);
}
async function newAcc(owner: PublicKey, size: number): Promise<PublicKey> {
  const kp = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(size);
  await send(funder, [SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports, space: size, programId: owner })], [kp]);
  return kp.publicKey;
}
const tokAmt = (b: Buffer) => b.readBigUInt64LE(64); // SPL token account `amount`
const tokBal = async (k: PublicKey) => tokAmt(Buffer.from((await conn.getAccountInfo(k, "confirmed"))!.data));
const equity = (p: Portfolio) => p.capital + p.totalLockedMm + p.legs.reduce((a, l) => a + l.posPnl, 0n);
const legOf = (p: Portfolio, m: PublicKey) => p.legs.find((l) => l.market.equals(m) && l.side !== 0);

async function main() {
  await assertDevnet(conn);
  console.log(`PropAMM devnet proof — percolator ${P.toBase58()} matcher ${M.toBase58()} via ${mask(RPC)}`);

  // ------------------------------------------------------------------ setup: mint, DEX, 3 markets
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send(funder, [initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate(), rewKp = Keypair.generate();
  const MARK = 100n * POS_SCALE, FEE_BPS = 2n, MAX_MOVE = 100n;
  // K5 bound: maxMove=100, liqFee=50, mm=600, im=1000. maxStaleness 9000 slots (~1h): NO oracle update during P&L sections.
  const base: MarketParams = { initPrice: MARK, exitWindow: 10n, maxStaleness: 9000n, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: FEE_BPS, maxMoveBps: MAX_MOVE, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  // Market A: built-in funding ON (fee remainder -> protocol surplus S) + 50% of fees -> rewardAccrued for `rewKp`.
  const mA = await newAcc(P, MARKET_SIZE), mB = await newAcc(P, MARKET_SIZE), mC = await newAcc(P, MARKET_SIZE), mD = await newAcc(P, MARKET_SIZE);
  const mk = (market: PublicKey, params: MarketParams) => createMarket(P, { dex, market, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params });
  await send(funder, [mk(mA, { ...base, fundingCfg: packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 720 }), rewardBps: 5000n, rewardRecipient: rewKp.publicKey })]);
  await send(funder, [mk(mB, base)]);
  await send(funder, [mk(mC, base)]);
  await send(funder, [mk(mD, { ...base, maxStaleness: 150n })]); // short staleness window (~1 min), like the planned bounty market

  // actors: LP owner, two takers, an attacker. Each pays its own fees so signature counts are meaningful.
  const lpOwner = Keypair.generate(), t1 = Keypair.generate(), t2 = Keypair.generate(), mallory = Keypair.generate();
  await send(funder, [lpOwner, t1, t2, mallory, rewKp].map((k) => SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: k.publicKey, lamports: 60_000_000 })));
  const pLP = await newAcc(P, PORTFOLIO_SIZE), p1 = await newAcc(P, PORTFOLIO_SIZE), p2 = await newAcc(P, PORTFOLIO_SIZE);
  await send(funder, [initPortfolio(P, { dex, portfolio: pLP, owner: lpOwner.publicKey })], [lpOwner]);
  await send(funder, [initPortfolio(P, { dex, portfolio: p1, owner: t1.publicKey })], [t1]);
  await send(funder, [initPortfolio(P, { dex, portfolio: p2, owner: t2.publicKey })], [t2]);
  const LP_DEPOSIT = 5_000n * POS_SCALE;
  await send(funder, [
    depositCollateral(P, V, { portfolio: pLP, depositor: funder.publicKey, sourceToken: fTok, amount: LP_DEPOSIT }),
    depositCollateral(P, V, { portfolio: p1, depositor: funder.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE }),
    depositCollateral(P, V, { portfolio: p2, depositor: funder.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE }),
  ]);

  // ------------------------------------------------------------------ same-slot snapshot + conservation
  const ctxKp = Keypair.generate(), ctx = ctxKp.publicKey;
  const KEYS = [dex, V.vault, mA, mB, mC, pLP, p1, p2, ctx, mD];
  interface Snap { slot: number; dex: Dex; spl: bigint; A: Market; B: Market; C: Market; D: Market; lp: Portfolio; p1: Portfolio; p2: Portfolio; ctx: PropAmmCtx | null }
  async function snap(label: string): Promise<Snap> {
    let res: Awaited<ReturnType<typeof conn.getMultipleAccountsInfoAndContext>>;
    for (let i = 0; ; i++) { // ONE call => every account from the same slot, and never older than our last tx
      try { res = await conn.getMultipleAccountsInfoAndContext(KEYS, { commitment: "confirmed", minContextSlot: lastTxSlot }); break; }
      catch (e) { if (i < 40 && /Minimum context slot|429|fetch failed/i.test(String(e))) { await sleep(400); continue; } throw new Error(mask(String(e))); }
    }
    const b = res.value.map((a) => (a ? Buffer.from(a.data) : null));
    const d = parseDex(b[0]!), spl = tokAmt(b[1]!);
    const [A, B, C, D] = [parseMarket(b[2]!), parseMarket(b[3]!), parseMarket(b[4]!), parseMarket(b[9]!)];
    const [lp, q1, q2] = [parsePortfolio(b[5]!), parsePortfolio(b[6]!), parsePortfolio(b[7]!)];
    const sum = d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards;
    const rep = checkDexInvariants(d, spl, [A, B, C, D], [lp, q1, q2]);
    ok(d.vaultBalance === spl && spl === sum && rep.ok,
      `[conservation @slot ${res.context.slot}] ${label}: V=${U(d.vaultBalance)} == SPL == C ${U(d.totalCapital)} + I ${U(d.totalInsurance)} + R ${U(d.totalResidual)} + S ${U(d.totalSurplus)} + Rew ${U(d.totalRewards)}${rep.ok ? "" : " — " + rep.problems.join("; ")}`);
    return { slot: res.context.slot, dex: d, spl, A, B, C, D, lp, p1: q1, p2: q2, ctx: b[8] && accountKind(b[8]) === "propAmmCtx" ? parsePropAmmCtx(b[8]) : null };
  }
  let s = await snap("after setup (LP 5000, takers 1000 each)");
  const [idA, idB, idC, idD] = [s.A.marketId, s.B.marketId, s.C.marketId, s.D.marketId];
  console.log(`market ids: A=${idA} (funding+reward) B=${idB} C=${idC} (NOT allowlisted) D=${idD} (maxStaleness 150 slots)`);

  // ------------------------------------------------------------------ 1. InitPropAmm + SetPortfolioMatcher
  console.log("\n1. InitPropAmm (ctx created + initialized in ONE tx) / SetPortfolioMatcher");
  let params = { halfSpreadBps: 20n, impactBps: 2n, maxFillQty: 5n * POS_SCALE };
  const rent272 = await conn.getMinimumBalanceForRentExemption(PROP_CTX_SIZE);
  await send(lpOwner, [
    SystemProgram.createAccount({ fromPubkey: lpOwner.publicKey, newAccountPubkey: ctx, lamports: rent272, space: PROP_CTX_SIZE, programId: M }),
    propAmmInit(M, { ctx, owner: lpOwner.publicKey, ...params, allowedMarketIds: [idA, idB, idD] }),
  ], [ctxKp]);
  s = await snap("InitPropAmm");
  const c0 = s.ctx!;
  ok(!!c0 && c0.owner.equals(lpOwner.publicKey) && c0.halfSpreadBps === 20n && c0.impactBps === 2n && c0.maxFillQty === 5n * POS_SCALE && !c0.paused
    && c0.allowedCount === 3 && c0.allowedMarkets[0] === idA && c0.allowedMarkets[1] === idB && c0.allowedMarkets[2] === idD && c0.status === 0 && c0.seq === 0n,
    `parsePropAmmCtx: owner=LP half=20bps impact=2bps/unit maxFill=5 allow=[${c0?.allowedMarkets}] seq=0`);
  await expectErr("re-Init of a live ctx by another signer", mallory, [propAmmInit(M, { ctx, owner: mallory.publicKey, ...params, halfSpreadBps: 0n, allowedMarketIds: [idC] })], [], "AccountAlreadyInitialized");
  const legA = (mode: number, takerIsLong: boolean, qty: bigint, limitPrice?: bigint): MatcherLeg => ({ market: mA, mode, takerIsLong, maxQty: qty, limitPrice });
  const legB = (mode: number, takerIsLong: boolean, qty: bigint, limitPrice?: bigint): MatcherLeg => ({ market: mB, mode, takerIsLong, maxQty: qty, limitPrice });
  const twmArgs = (taker: Keypair, pfl: PublicKey, legs: MatcherLeg[]) => ({ dex, takerPortfolio: pfl, taker: taker.publicKey, lpPortfolio: pLP, matcherProgram: M, matcherCtx: ctx, legs });
  const twm = (taker: Keypair, pfl: PublicKey, legs: MatcherLeg[], over: Partial<Parameters<typeof tradeWithMatcher>[1]> = {}) =>
    tradeWithMatcher(P, { ...twmArgs(taker, pfl, legs), ...over });
  await expectErr("TradeWithMatcher before the LP bound the ctx", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.OPEN, true, POS_SCALE)])], [], 131);
  await expectErr("SetPortfolioMatcher by NON-owner", mallory, [setPortfolioMatcher(P, { portfolio: pLP, owner: mallory.publicKey, matcherCtx: ctx })], [], 111);
  await send(lpOwner, [setPortfolioMatcher(P, { portfolio: pLP, owner: lpOwner.publicKey, matcherCtx: ctx })]);
  s = await snap("SetPortfolioMatcher");
  ok(s.lp.matcherCtx.equals(ctx), "LP portfolio.matcherCtx == ctx (bound by the LP owner)");

  // ------------------------------------------------------------------ quote inspection: pure vs simulated on-chain
  const mktOf = (x: Snap, m: PublicKey) => (m.equals(mA) ? x.A : m.equals(mB) ? x.B : m.equals(mD) ? x.D : x.C);
  const quoteLegs = (x: Snap, legs: MatcherLeg[]) => legs.map((l) => { const mk_ = mktOf(x, l.market); return { mode: l.mode, takerIsLong: l.takerIsLong, marketId: mk_.marketId, maxQty: l.maxQty, markPrice: mk_.markPrice, maxMoveBps: mk_.maxMoveBps }; });
  {
    const legs = [legA(TRADE_MODE.NETTED, true, 3n * POS_SCALE), legB(TRADE_MODE.NETTED, false, 7n * POS_SCALE)];
    const pure = propAmmQuote(s.ctx!, quoteLegs(s, legs));
    const tx = new Transaction().add(propAmmQuoteIx(M, { ctx, seq: 777n, offers: quoteLegs(s, legs) }));
    tx.feePayer = funder.publicKey;
    const sim = await conn.simulateTransaction(tx, [funder], [ctx]);
    const post = parsePropAmmCtx(Buffer.from(sim.value.accounts![0]!.data[0], "base64"));
    ok(sim.value.err === null && post.seq === 777n && pure.every((q, i) => q.execPrice === post.quotes[i].execPrice && q.fillQty === post.quotes[i].fillQty),
      `quote inspection: propAmmQuote() == SIMULATED raw PropAmmQuote for a hedged basket [A buy 3 @${U(pure[0].execPrice)}, B sell 7→fill ${U(pure[1].fillQty)} @${U(pure[1].execPrice)}] (half-spread halved: ${pure[0].hedged})`);
  }

  // ------------------------------------------------------------------ generic verified taker trade
  /** Taker-only-signed TradeWithMatcher; verifies price vs propAmmQuote, spread direction, P&L accounting, conservation. */
  async function tradeStep(label: string, taker: Keypair, takerPfl: PublicKey, legs: MatcherLeg[], o: { lpPaysFee?: boolean[]; refresh?: boolean; skipPnl?: boolean } = {}) {
    const pre = await snap(`before ${label}`);
    const exp = propAmmQuote(pre.ctx!, quoteLegs(pre, legs));
    const ixs = o.refresh ? await tradeWithMatcherFresh(conn, P, twmArgs(taker, takerPfl, legs)) : [twm(taker, takerPfl, legs)];
    const nSig = await send(taker, [CU, ...ixs]);
    const post = await snap(label);
    const tk = (x: Snap) => (takerPfl.equals(p1) ? x.p1 : x.p2);
    let spreadSum = 0n, feeSum = 0n, lpFee = 0n, priceOk = true, sideOk = true;
    legs.forEach((l, i) => {
      const mark = mktOf(pre, l.market).markPrice, q = post.ctx!.quotes[i];
      priceOk &&= q.execPrice === exp[i].execPrice && q.fillQty === exp[i].fillQty;
      sideOk &&= matcherLegIsBuy(l) ? q.execPrice >= mark : q.execPrice <= mark;
      const diff = q.execPrice > mark ? q.execPrice - mark : mark - q.execPrice;
      spreadSum += ceilDiv(q.fillQty * diff, POS_SCALE);
      const fee = ceilDiv(ceilDiv(q.fillQty * mark, POS_SCALE) * mktOf(pre, l.market).tradeFeeBps, BPS_DEN);
      feeSum += fee;
      if (o.lpPaysFee?.[i]) lpFee += fee;
    });
    const dLp = equity(post.lp) - equity(pre.lp), dTk = equity(tk(post)) - equity(tk(pre));
    const feesCredited = (post.dex.totalInsurance + post.dex.totalSurplus + post.dex.totalRewards) - (pre.dex.totalInsurance + pre.dex.totalSurplus + pre.dex.totalRewards);
    const desc = legs.map((l, i) => `${matcherLegIsBuy(l) ? "BUY" : "SELL"} ${U(post.ctx!.quotes[i].fillQty)} ${l.market.equals(mA) ? "A" : l.market.equals(mB) ? "B" : "D"} @${U(post.ctx!.quotes[i].execPrice)} (mark ${U(mktOf(pre, l.market).markPrice)}, ${exp[i].effBps}bps${exp[i].hedged ? " hedged" : ""})`).join(" + ");
    ok(nSig === 1, `${label}: landed with exactly 1 signature (taker only; LP did not sign)`);
    ok(priceOk && post.ctx!.seq === ((pre.ctx!.seq + 1n) & ((1n << 64n) - 1n)), `${label}: ${desc} == propAmmQuote(), seq ${pre.ctx!.seq}→${post.ctx!.seq}`);
    ok(sideOk, `${label}: buyer price >= mark / seller price <= mark`);
    const lpOk = o.lpPaysFee ? dLp === spreadSum - lpFee : dLp <= spreadSum && dLp >= spreadSum - feeSum;
    if (o.skipPnl) console.log(`    (P&L not asserted here: the bundled RefreshLeg also settles oracle-move PnL) LP ${U(dLp)}, taker ${U(dTk)}`);
    else ok(lpOk && dLp + dTk === -feesCredited && dTk <= -spreadSum,
      `${label}: LP equity ${dLp >= 0n ? "+" : ""}${U(dLp)} (spread ${U(spreadSum)} − LP fee ${U(spreadSum - dLp)}), taker ${U(dTk)}, protocol fees +${U(feesCredited)}`);
    return { pre, post, dLp, exp };
  }
  const flat = (x: Snap) => x.lp.legs.every((l) => l.side === 0) && x.A.oiLong === 0n && x.B.oiLong === 0n && x.D.oiLong === 0n;

  // ------------------------------------------------------------------ 2. round trips at an unchanged oracle
  const Q = POS_SCALE; // 1.0 unit @ $100
  for (const round of [1, 2]) {
    console.log(`\n2.${round} round trips (oracle unchanged at $100; half-spread 20 bps + impact 2 bps/unit, trade fee ${FEE_BPS} bps)`);
    const lp0 = equity((await snap(`round ${round} start`)).lp);
    // (a) OPEN long vs vault, CLOSE it: LP pays the fee on the open only.
    await tradeStep(`r${round} T1 OPEN long 1 A (mode 0)`, t1, p1, [legA(TRADE_MODE.OPEN, true, Q)], { lpPaysFee: [true] });
    await tradeStep(`r${round} T1 CLOSE long 1 A (mode 1)`, t1, p1, [legA(TRADE_MODE.CLOSE, true, Q)], { lpPaysFee: [false] });
    const lp1 = equity((s = await snap(`r${round} after long round trip`)).lp);
    const spread1 = (MARK * 22n / BPS_DEN), fee1 = ceilDiv(MARK * FEE_BPS, BPS_DEN);
    ok(flat(s) && lp1 - lp0 === 2n * spread1 - fee1 && lp1 > lp0, `r${round} LP P&L on taker long round trip = +${U(lp1 - lp0)} == 2×spread ${U(spread1)} − 1×fee ${U(fee1)} (earned the spread, principal intact)`);
    // (b) OPEN short vs vault, CLOSE it.
    await tradeStep(`r${round} T2 OPEN short 1 A (mode 0)`, t2, p2, [legA(TRADE_MODE.OPEN, false, Q)], { lpPaysFee: [true] });
    await tradeStep(`r${round} T2 CLOSE short 1 A (mode 1)`, t2, p2, [legA(TRADE_MODE.CLOSE, false, Q)], { lpPaysFee: [false] });
    const lp2 = equity((s = await snap(`r${round} after short round trip`)).lp);
    ok(flat(s) && lp2 - lp1 === 2n * spread1 - fee1, `r${round} LP P&L on taker short round trip = +${U(lp2 - lp1)}`);
    // (c) NETTED mode with LP inventory: T1 buys (LP short), T2 sells (LP's short is handed to T2), T1 sells
    //     (LP takes over T1's long), T2 buys (closes vs LP). LP pays a fee only when it ends up opening.
    await tradeStep(`r${round} T1 BUY 1 A (netted, LP flat→short)`, t1, p1, [legA(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true] });
    if (round === 1) {
      await expectErr("T2 OPEN short (mode 0) while the LP is SHORT", t2, [CU, twm(t2, p2, [legA(TRADE_MODE.OPEN, false, Q)])], [], 121);
      await expectErr("T2 CLOSE (mode 1) with no position", t2, [CU, twm(t2, p2, [legA(TRADE_MODE.CLOSE, true, Q)])], [], 125);
    }
    await tradeStep(`r${round} T2 SELL 1 A (netted, LP short handed off → LP flat)`, t2, p2, [legA(TRADE_MODE.NETTED, false, Q)], { lpPaysFee: [false] });
    await tradeStep(`r${round} T1 SELL 1 A (netted, LP takes T1's long)`, t1, p1, [legA(TRADE_MODE.NETTED, false, Q)], { lpPaysFee: [true] });
    await tradeStep(`r${round} T2 BUY 1 A (netted, closes vs LP long)`, t2, p2, [legA(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [false] });
    const lp3 = equity((s = await snap(`r${round} after netted 4-trade cycle`)).lp);
    ok(flat(s) && lp3 - lp2 === 4n * spread1 - 2n * fee1, `r${round} LP P&L on netted cycle = +${U(lp3 - lp2)} == 4×spread − 2×fee; everyone flat, OI 0`);
    console.log(`  LP P&L round ${round}: +${U(lp3 - lp0)} on 8 fills of 1.0 @ $100 (capital ${U(s.lp.capital)})`);
  }

  // ------------------------------------------------------------------ 3. limit price
  console.log("\n3. taker limit price (slippage protection is enforced by CORE: execPriceClamp 130)");
  s = await snap("before limit tests");
  const ask1 = propAmmQuote(s.ctx!, quoteLegs(s, [legA(TRADE_MODE.NETTED, true, Q)]))[0].execPrice;
  const bid1 = propAmmQuote(s.ctx!, quoteLegs(s, [legA(TRADE_MODE.NETTED, false, Q)]))[0].execPrice;
  await expectErr(`BUY with limit ${U(ask1 - 1n)} < ask ${U(ask1)}`, t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, true, Q, ask1 - 1n)])], [], 130);
  await expectErr(`SELL with limit ${U(bid1 + 1n)} > bid ${U(bid1)}`, t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, false, Q, bid1 + 1n)])], [], 130);
  await tradeStep("T1 BUY 1 A with limit == ask (fills)", t1, p1, [legA(TRADE_MODE.NETTED, true, Q, ask1)], { lpPaysFee: [true] });
  await tradeStep("T1 SELL 1 A with limit == bid (fills, flat again)", t1, p1, [legA(TRADE_MODE.NETTED, false, Q, bid1)], { lpPaysFee: [false] });

  // ------------------------------------------------------------------ 4. owner updates; maxFillQty clamps
  console.log("\n4. UpdatePropAmm: owner-gated; maxFillQty is a CLAMP (partial fill), not a rejection");
  await expectErr("UpdatePropAmm by NON-owner", mallory, [propAmmUpdate(M, { ctx, owner: mallory.publicKey, halfSpreadBps: 0n, impactBps: 0n, maxFillQty: 1n })], [], 111);
  params = { halfSpreadBps: 40n, impactBps: 10n, maxFillQty: POS_SCALE / 2n };
  await send(lpOwner, [propAmmUpdate(M, { ctx, owner: lpOwner.publicKey, ...params })]);
  s = await snap("UpdatePropAmm(half=40, impact=10, maxFill=0.5)");
  ok(s.ctx!.halfSpreadBps === 40n && s.ctx!.impactBps === 10n && s.ctx!.maxFillQty === POS_SCALE / 2n && !s.ctx!.paused && s.ctx!.allowedMarkets.join() === [idA, idB, idD].join(), "owner update applied; allowlist unchanged");
  const big = await tradeStep("T1 BUY maxQty 2 A with maxFillQty 0.5", t1, p1, [legA(TRADE_MODE.NETTED, true, 2n * Q)], { lpPaysFee: [true] });
  ok(big.post.ctx!.quotes[0].fillQty === Q / 2n && big.post.A.oiLong - big.pre.A.oiLong === Q / 2n && legOf(big.post.p1, mA)?.rawBasis === Q / 2n,
    `request 2.0 was PARTIALLY filled: fillQty ${U(big.post.ctx!.quotes[0].fillQty)}, OI +${U(big.post.A.oiLong - big.pre.A.oiLong)} (no error; the taker has no min-fill field)`);
  ok(big.exp[0].effBps === 45n, `new params priced in: 40 + floor(0.5 × 10) = ${big.exp[0].effBps} bps`);

  // ------------------------------------------------------------------ 5. pause / unpause
  console.log("\n5. pause blocks EVERYTHING (opens and closes), unpause restores");
  await send(lpOwner, [propAmmUpdate(M, { ctx, owner: lpOwner.publicKey, ...params, paused: true })]);
  s = await snap("pause");
  ok(s.ctx!.paused, "ctx.paused = true");
  await expectErr("T2 BUY while paused", t2, [CU, twm(t2, p2, [legA(TRADE_MODE.NETTED, true, Q)])], [], 200);
  await expectErr("T1 CLOSE its open long while paused", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.CLOSE, true, Q / 2n)])], [], 200);
  params = { halfSpreadBps: 20n, impactBps: 2n, maxFillQty: 5n * POS_SCALE };
  await send(lpOwner, [propAmmUpdate(M, { ctx, owner: lpOwner.publicKey, ...params })]); // paused omitted => false
  s = await snap("unpause + restore params");
  ok(!s.ctx!.paused && s.ctx!.maxFillQty === 5n * POS_SCALE, "ctx.paused = false, maxFill back to 5");
  await tradeStep("T1 SELL 0.5 A after unpause (flat again)", t1, p1, [legA(TRADE_MODE.NETTED, false, Q / 2n)], { lpPaysFee: [false] });

  // ------------------------------------------------------------------ 6. allowlist / binding attacks
  console.log("\n6. immutable allowlist + ctx binding");
  const legC: MatcherLeg = { market: mC, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: Q };
  await expectErr("trade on market C (not in allowlist)", t1, [CU, twm(t1, p1, [legC])], [], 201);
  await expectErr("basket [A, C] (one leg not in allowlist)", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, true, Q), legC])], [], 201);
  // attacker makes their OWN zero-spread ctx that allows C and tries to use it against the LP portfolio
  const evilKp = Keypair.generate();
  await send(mallory, [
    SystemProgram.createAccount({ fromPubkey: mallory.publicKey, newAccountPubkey: evilKp.publicKey, lamports: rent272, space: PROP_CTX_SIZE, programId: M }),
    propAmmInit(M, { ctx: evilKp.publicKey, owner: mallory.publicKey, halfSpreadBps: 0n, impactBps: 0n, maxFillQty: 1_000_000n * POS_SCALE, allowedMarketIds: [idA, idB, idC] }),
  ], [evilKp]);
  await expectErr("attacker's own zero-spread ctx against the LP portfolio", mallory, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, false, Q)], { matcherCtx: evilKp.publicKey })], [t1], 131);
  await expectErr("right ctx but a different matcher program", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, true, Q)], { matcherProgram: ORACLE_ADAPTER })], [], 131);
  // PropAmmQuote (matcher op 2) has NO signer / caller check: a stranger really sends it against the LP's ctx with
  // seq = 2^64-1 and an absurd mark, scribbling over the header + quote slots. The next real fill must be unaffected.
  await send(mallory, [propAmmQuoteIx(M, { ctx, seq: (1n << 64n) - 1n, offers: [{ mode: TRADE_MODE.NETTED, takerIsLong: false, marketId: idA, maxQty: 5n * POS_SCALE, markPrice: 1n, maxMoveBps: 10_000n }] })]);
  s = await snap("stranger sent a raw PropAmmQuote to the LP's ctx");
  ok(s.ctx!.seq === (1n << 64n) - 1n && s.ctx!.quotes[0].execPrice === 1n && s.ctx!.halfSpreadBps === params.halfSpreadBps && s.ctx!.owner.equals(lpOwner.publicKey) && s.ctx!.allowedMarkets.join() === [idA, idB, idD].join(),
    `ctx header/quote slots were overwritten by a stranger (seq=2^64-1, slot0 price ${s.ctx!.quotes[0].execPrice}) but owner/params/allowlist are intact`);
  await tradeStep("T1 BUY 1 A right after the scribble (seq wraps to 0, correct price)", t1, p1, [legA(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true] });
  await tradeStep("T1 SELL 1 A", t1, p1, [legA(TRADE_MODE.NETTED, false, Q)], { lpPaysFee: [false] });
  await send(lpOwner, [setPortfolioMatcher(P, { portfolio: pLP, owner: lpOwner.publicKey, matcherCtx: null })]);
  s = await snap("SetPortfolioMatcher(null) = unbind");
  ok(s.lp.matcherCtx.equals(PublicKey.default), "LP unbound the matcher (matcherCtx = 0)");
  await expectErr("trade after the LP revoked the matcher", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, true, Q)])], [], 131);
  await send(lpOwner, [setPortfolioMatcher(P, { portfolio: pLP, owner: lpOwner.publicKey, matcherCtx: ctx })]);
  s = await snap("re-bind");

  // ------------------------------------------------------------------ 7. k=2 baskets
  console.log("\n7. multi-market basket (k=2) in ONE instruction, one taker signature");
  const hedged = await tradeStep("T1 basket BUY 1 A + SELL 1 B (hedged)", t1, p1, [legA(TRADE_MODE.NETTED, true, Q), legB(TRADE_MODE.NETTED, false, Q)], { lpPaysFee: [true, true] });
  ok(hedged.exp[0].hedged && hedged.exp[0].effBps === 12n && hedged.exp[1].effBps === 12n, `hedged basket discount: half-spread 20→10 bps (+2 impact) = ${hedged.exp[0].effBps} bps per leg`);
  // LP now holds legs in A (short) and B (long): a single-market trade must refresh the OTHER leg and carry its market.
  await expectErr("T1 basket unwind WITHOUT refreshing first (its own B leg is stale when the A leg settles)", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, false, Q), legB(TRADE_MODE.NETTED, true, Q)])], [], 122);
  await expectErr("T2 BUY A while the LP's B leg is not refreshed/present", t2, [CU, twm(t2, p2, [legA(TRADE_MODE.NETTED, true, Q)])], [], 122);
  await tradeStep("T2 BUY 1 A via withLegRefresh (refreshes LP's B leg + appends market B)", t2, p2, [legA(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true], refresh: true });
  await tradeStep("T2 SELL 1 A via withLegRefresh", t2, p2, [legA(TRADE_MODE.NETTED, false, Q)], { lpPaysFee: [false], refresh: true });
  await tradeStep("T1 basket SELL 1 A + BUY 1 B (hedged unwind)", t1, p1, [legA(TRADE_MODE.NETTED, false, Q), legB(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [false, false], refresh: true });
  const same = await tradeStep("T2 basket BUY 1 A + BUY 1 B (same direction: no discount)", t2, p2, [legA(TRADE_MODE.NETTED, true, Q), legB(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true, true] });
  ok(!same.exp[0].hedged && same.exp[0].effBps === 22n, `same-direction basket pays the full ${same.exp[0].effBps} bps`);
  await tradeStep("T2 basket SELL 1 A + SELL 1 B (unwind)", t2, p2, [legA(TRADE_MODE.NETTED, false, Q), legB(TRADE_MODE.NETTED, false, Q)], { lpPaysFee: [false, false], refresh: true });
  s = await snap("after baskets");
  ok(flat(s), "everyone flat again, OI 0 on A and B");
  const lpFlat = equity(s.lp);
  console.log(`  LP total P&L at an UNCHANGED oracle so far: +${U(lpFlat - LP_DEPOSIT)} (deposit ${U(LP_DEPOSIT)} → equity ${U(lpFlat)})`);
  ok(lpFlat > LP_DEPOSIT && s.lp.capital === lpFlat, "LP never lost principal at an unchanged oracle: equity > deposit, all of it free capital");

  // ------------------------------------------------------------------ 8. ClaimReward / SweepSurplus
  console.log("\n8. ClaimReward (op 21)");
  const rewTok = await createAccount(conn, funder, mint, rewKp.publicKey, Keypair.generate());
  const accrued = s.A.rewardAccrued;
  ok(accrued > 0n && s.dex.totalRewards === accrued, `market A accrued reward ${U(accrued)} (rewardBps 5000 = 50% of its trade fees; the rest went to I ${U(s.A.insurance)} / S ${U(s.dex.totalSurplus)})`);
  await expectErr("ClaimReward signed by a non-recipient", mallory, [claimReward(P, V, { market: mA, rewardAuth: mallory.publicKey, destToken: rewTok })], [], 102);
  await expectErr("ClaimReward more than accrued", rewKp, [claimReward(P, V, { market: mA, rewardAuth: rewKp.publicKey, destToken: rewTok, amount: accrued + 1n })], [], 103);
  await send(rewKp, [claimReward(P, V, { market: mA, rewardAuth: rewKp.publicKey, destToken: rewTok, amount: 1n })]);
  await send(rewKp, [claimReward(P, V, { market: mA, rewardAuth: rewKp.publicKey, destToken: rewTok })]); // 0 = all
  s = await snap("ClaimReward (1 unit, then all)");
  ok((await tokBal(rewTok)) === accrued && s.A.rewardAccrued === 0n && s.dex.totalRewards === 0n, `recipient received exactly ${U(accrued)}; market.rewardAccrued = 0, Dex.totalRewards = 0`);

  // ------------------------------------------------------------------ 9. availability: ramp cooldown
  console.log("\n9. availability: an oracle tick >= half the clamp makes the PropAMM refuse ALL quotes for 150 slots");
  await tradeStep("T1 BUY 1 B (LP short B)", t1, p1, [legB(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true] });
  await sleep(1500); // dt >= 2 slots since the last oracle slot is guaranteed (market B was created minutes ago)
  await send(funder, [updateOracle(P, { market: mB, oracleAuth: oracle.publicKey, price: MARK + MARK * 60n / BPS_DEN })], [oracle]); // +0.6% of a 1% clamp
  s = await snap("oracle B +0.6%");
  const rampSlot = s.B.lastRampSlot;
  ok(s.B.markPrice === MARK + MARK * 60n / BPS_DEN && rampSlot > 0n, `mark B = ${U(s.B.markPrice)}, lastRampSlot = ${rampSlot}`);
  try { propAmmQuote(s.ctx!, [{ ...quoteLegs(s, [legB(TRADE_MODE.CLOSE, true, Q)])[0], isRamping: true }]); ok(false, "propAmmQuote should throw while ramping"); }
  catch (e) { ok((e as any).code === 200, "propAmmQuote(isRamping) throws PropAmmQuoteError(200)"); }
  await expectErr("T1 CLOSE its long on B during the ramp cooldown", t1, [CU, twm(t1, p1, [legB(TRADE_MODE.CLOSE, true, Q)])], [], 200);
  await expectErr("T2 SELL B (would REDUCE LP risk) during the ramp cooldown", t2, [CU, twm(t2, p2, [legB(TRADE_MODE.NETTED, false, Q)])], [], 200);
  // realize the B mark-to-market on its own (LP loss -> realized pool -> T1 gain) so the next steps' P&L checks are pure spread
  await send(funder, [refreshLeg(P, { dex, market: mB, portfolio: pLP }), refreshLeg(P, { dex, market: mB, portfolio: p1 })]);
  await tradeStep("market A still trades during B's cooldown (T2 BUY 1 A, LP's B leg refreshed)", t2, p2, [legA(TRADE_MODE.NETTED, true, Q)], { refresh: true });
  await tradeStep("T2 SELL 1 A", t2, p2, [legA(TRADE_MODE.NETTED, false, Q)], { refresh: true });
  process.stdout.write("  waiting out the 150-slot cooldown");
  while (BigInt(await conn.getSlot("confirmed")) <= rampSlot + 152n) { await sleep(5000); process.stdout.write("."); }
  console.log("");
  const lpBefore = equity((await snap("cooldown over")).lp);
  // LP is short 1 B from $100; mark is now $100.60 => LP carries a -0.60 mark-to-market loss (inventory risk, not a leak).
  await send(t1, [CU, ...(await withLegRefresh(conn, [twm(t1, p1, [legB(TRADE_MODE.NETTED, false, Q)])], { percolator: P, matcher: M })).instructions]);
  s = await snap("T1 SELL 1 B after cooldown (closes vs LP)");
  ok(flat(s), `PropAMM quotes again after the cooldown; all flat. LP equity ${U(lpBefore)} → ${U(equity(s.lp))} (inventory loss from the +0.6% move while short 1 B, as expected)`);


  // ------------------------------------------------------------------ 9b. keep the AMM not stale
  console.log("\n9b. staleness: oracle older than maxStaleness (150 slots) ⇒ oracleStale; fresh push ⇒ trades at the NEW mark; open legs need RefreshLeg");
  const legD = (mode: number, takerIsLong: boolean, qty: bigint, limitPrice?: bigint): MatcherLeg => ({ market: mD, mode, takerIsLong, maxQty: qty, limitPrice });
  const push = async (price: bigint) => { await send(funder, [updateOracle(P, { market: mD, oracleAuth: oracle.publicKey, price })], [oracle]); };
  s = await snap("before stale-oracle test");
  const age = BigInt(s.slot) - s.D.lastOracleSlot;
  ok(age > s.D.maxStaleness && s.D.maxStaleness === 150n, `market D oracle age ${age} slots > maxStaleness ${s.D.maxStaleness}`);
  await expectErr("T1 BUY D vs the vault with a STALE oracle", t1, [CU, twm(t1, p1, [legD(TRADE_MODE.NETTED, true, Q)])], [], 106);
  await expectErr("same via the one-call helper (refresh cannot cure a stale ORACLE)", t1, [CU, ...(await tradeWithMatcherFresh(conn, P, twmArgs(t1, p1, [legD(TRADE_MODE.NETTED, true, Q)])))], [], 106);
  const MARK2 = MARK + MARK * 40n / BPS_DEN; // $100.40 (market is empty => mark snaps to the pushed price)
  await push(MARK2);
  const d1 = await tradeStep("T1 BUY 1 D right after a fresh oracle push", t1, p1, [legD(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true] });
  ok(d1.pre.D.markPrice === MARK2 && d1.post.ctx!.quotes[0].execPrice === MARK2 + MARK2 * 22n / BPS_DEN && d1.post.ctx!.quotes[0].execPrice >= MARK2,
    `fill used the NEW mark ${U(MARK2)}: ask ${U(d1.post.ctx!.quotes[0].execPrice)} = new mark + 22 bps (not the old $100 mark)`);
  // The LP now HOLDS an open D leg (short 1) and T1 an open D leg (long 1). A trade on ANOTHER market needs both refreshed.
  s = await snap("LP holds an open D position");
  const refSlot = legOf(s.lp, mD)!.lastRefreshSlot;
  const tB = () => twm(t1, p1, [legB(TRADE_MODE.NETTED, true, Q)]);
  await expectErr("T1 BUY B, NO RefreshLeg at all", t1, [CU, tB()], [], 122, Number(refSlot));
  await expectErr("T1 BUY B, taker's D leg refreshed but the LP's D leg NOT", t1, [CU, refreshLeg(P, { dex, market: mD, portfolio: p1 }), tB()], [], 122, Number(refSlot));
  await expectErr("T1 BUY B, LP's D leg refreshed but the taker's NOT", t1, [CU, refreshLeg(P, { dex, market: mD, portfolio: pLP }), tB()], [], 122, Number(refSlot));
  const bundle = await tradeWithMatcherFresh(conn, P, twmArgs(t1, p1, [legB(TRADE_MODE.NETTED, true, Q)]));
  ok(bundle.length === 3 && bundle.slice(0, 2).every((i) => i.data[0] === 10) && bundle[2].data[0] === 23,
    `tradeWithMatcherFresh built [RefreshLeg(D, ${bundle.slice(0, 2).map((i) => (i.keys[2].pubkey.equals(pLP) ? "LP" : "taker")).join("), RefreshLeg(D, ")}), TradeWithMatcher] in one call`);
  await tradeStep("T1 BUY 1 B with the one-call bundle (LP + taker D legs refreshed)", t1, p1, [legB(TRADE_MODE.NETTED, true, Q)], { lpPaysFee: [true], refresh: true });
  // Oracle moves +0.2% on the LOADED market (below the ramp threshold): the very next fill is priced off the new mark.
  const MARK3 = MARK2 + MARK2 * 20n / BPS_DEN;
  await push(MARK3);
  const d2 = await tradeStep("T2 BUY 1 D after the oracle moved +0.2% (loaded market)", t2, p2, [legD(TRADE_MODE.NETTED, true, Q)], { refresh: true, skipPnl: true });
  ok(d2.pre.D.markPrice === MARK3 && d2.pre.D.lastRampSlot === 0n && d2.post.ctx!.quotes[0].execPrice === MARK3 + MARK3 * 22n / BPS_DEN && d2.post.ctx!.quotes[0].execPrice > d1.post.ctx!.quotes[0].execPrice,
    `mark ${U(MARK2)} → ${U(MARK3)} (no ramp cooldown): next ask ${U(d2.post.ctx!.quotes[0].execPrice)} = NEW mark + 22 bps`);
  await tradeStep("T2 SELL 1 D (bid <= new mark)", t2, p2, [legD(TRADE_MODE.NETTED, false, Q)], { refresh: true, skipPnl: true });
  // Now let D's oracle go STALE while the LP still holds inventory (LP short 1 D + short 1 B; T1 long 1 D + long 1 B).
  process.stdout.write("  letting market D's oracle go stale again (150 slots) with LP inventory open");
  for (;;) { const cur = BigInt(await conn.getSlot("confirmed")); if (cur > d2.pre.D.lastOracleSlot + 155n) break; await sleep(5000); process.stdout.write("."); }
  console.log("");
  s = await snap("D oracle stale again, LP holds D + B legs");
  ok(BigInt(s.slot) - s.D.lastOracleSlot > 150n && !!legOf(s.lp, mD) && !!legOf(s.lp, mB), `D oracle age ${BigInt(s.slot) - s.D.lastOracleSlot} > 150 with the LP short D and short B`);
  const fresh = (taker: Keypair, pfl: PublicKey, legs: MatcherLeg[]) => tradeWithMatcherFresh(conn, P, twmArgs(taker, pfl, legs));
  await expectErr("T2 OPEN (BUY) D on the stale oracle", t2, [CU, ...(await fresh(t2, p2, [legD(TRADE_MODE.NETTED, true, Q)]))], [], 106);
  await expectOk("T1 CLOSE (mode 1) its D long on the STALE oracle — risk-reducing fills stay available", t1, [CU, ...(await fresh(t1, p1, [legD(TRADE_MODE.CLOSE, true, Q)]))]);
  await expectOk("T2 BUY B (fresh market) while the LP's D leg sits on a stale oracle — RefreshLeg(D) needs no fresh oracle, other markets keep trading", t2, [CU, ...(await fresh(t2, p2, [legB(TRADE_MODE.NETTED, true, Q)]))]);
  const dStale = await tradeStep("T1 SELL 1 D (netted = pure close) REALLY SENT on the stale oracle", t1, p1, [legD(TRADE_MODE.NETTED, false, Q)], { refresh: true, skipPnl: true });
  ok(dStale.post.ctx!.quotes[0].execPrice === MARK3 - MARK3 * 22n / BPS_DEN, `the close filled at the STALE mark ${U(MARK3)} − 22 bps = ${U(dStale.post.ctx!.quotes[0].execPrice)} (${BigInt(dStale.post.slot) - dStale.post.D.lastOracleSlot} slots old)`);
  await tradeStep("T1 SELL 1 B", t1, p1, [legB(TRADE_MODE.NETTED, false, Q)], { refresh: true, skipPnl: true });
  s = await snap("after staleness section");
  ok(flat(s), "everyone flat again (A, B, D)");

  // ------------------------------------------------------------------ 10. LP custody: withdraw everything
  console.log("\n10. LP owner keeps custody: withdraw everything");
  const lpTok = await createAccount(conn, funder, mint, lpOwner.publicKey, Keypair.generate());
  await expectErr("withdraw from the LP portfolio by a non-owner", mallory, [withdrawCollateral(P, V, { portfolio: pLP, owner: mallory.publicKey, destToken: lpTok, amount: 1n })], [], 111);
  const lpCap = s.lp.capital;
  await send(lpOwner, [withdrawCollateral(P, V, { portfolio: pLP, owner: lpOwner.publicKey, destToken: lpTok, amount: lpCap })]);
  s = await snap("LP withdrew all capital");
  ok((await tokBal(lpTok)) === lpCap && s.lp.capital === 0n, `LP owner withdrew ${U(lpCap)} (deposit ${U(LP_DEPOSIT)}; unchanged-oracle P&L +${U(lpFlat - LP_DEPOSIT)}, then ${U(lpCap - lpFlat)} from the section-9 price move/fills)`);

  // ------------------------------------------------------------------ 10b. SweepSurplus
  // At 887ba02 trade fees go to market insurance (+ reward); S only appears when a market with NO insurance-LP
  // shares is resolved (orphan insurance -> S). Wind market A down (all flat), resolve it, then sweep S.
  console.log("\n10b. SweepSurplus (op 20): resolve market A (orphan insurance → S), admin sweeps S to the fee vault");
  const s0 = s.dex.totalSurplus, insA = s.A.insurance;
  if (s0 === 0n) await expectErr("SweepSurplus with S == 0", funder, [sweepSurplus(P, V, { admin: funder.publicKey, feeVault })], [], 103);
  await send(funder, [startWindDown(P, { market: mA, caller: funder.publicKey })]);
  await send(funder, [resolveMarket(P, { dex, market: mA })]);
  s = await snap("StartWindDown + ResolveMarket(A)");
  const surplus = s.dex.totalSurplus;
  ok(s.A.statusName === "Resolved" && surplus === s0 + insA && surplus > 0n && s.A.insurance === 0n, `market A resolved: its orphan insurance ${U(insA)} moved to protocol surplus S = ${U(surplus)}`);
  await expectErr("trade on the resolved market", t1, [CU, twm(t1, p1, [legA(TRADE_MODE.NETTED, true, Q)])], [], 101);
  await expectErr("SweepSurplus signed by a non-admin", mallory, [sweepSurplus(P, V, { admin: mallory.publicKey, feeVault })], [], 102);
  await expectErr("SweepSurplus more than S", funder, [sweepSurplus(P, V, { admin: funder.publicKey, feeVault, amount: surplus + 1n })], [], 103);
  const fv0 = await tokBal(feeVault);
  await send(funder, [sweepSurplus(P, V, { admin: funder.publicKey, feeVault, amount: 1n })]);
  await send(funder, [sweepSurplus(P, V, { admin: funder.publicKey, feeVault })]); // 0 = all
  s = await snap("SweepSurplus (1 unit, then all)");
  ok((await tokBal(feeVault)) - fv0 === surplus && s.dex.totalSurplus === 0n, `feeVault received exactly S = ${U(surplus)}; Dex.totalSurplus = 0 (C/I/R untouched)`);
  await expectErr("SweepSurplus with nothing left", funder, [sweepSurplus(P, V, { admin: funder.publicKey, feeVault })], [], 103);

  // ------------------------------------------------------------------ 11. reward-module parsers vs live devnet accounts (read-only)
  console.log("\n11. reward-module parsers on live devnet accounts (read-only)");
  try {
    const accs = await conn.getProgramAccounts(REWARD_MODULE, { commitment: "confirmed" });
    const n = { rewardCfg: 0, epochState: 0, bidReceipt: 0, other: 0 };
    let bad = 0, linked = 0, bidLinked = 0;
    const cfgs = new Map<string, ReturnType<typeof parseRewardCfg>>(), epochs = new Map<string, ReturnType<typeof parseEpochState>>();
    const bids: ReturnType<typeof parseBidReceipt>[] = [];
    for (const a of accs) {
      const b = Buffer.from(a.account.data), kind = accountKind(b);
      try {
        if (kind === "rewardCfg") { cfgs.set(a.pubkey.toBase58(), parseRewardCfg(b)); n.rewardCfg++; }
        else if (kind === "epochState") { epochs.set(a.pubkey.toBase58(), parseEpochState(b)); n.epochState++; }
        else if (kind === "bidReceipt") { bids.push(parseBidReceipt(b)); n.bidReceipt++; }
        else n.other++;
      } catch { bad++; }
    }
    // cross-links prove the offsets: every epoch points at a parsed cfg; a cfg's active epoch carries its id; a bid points at a parsed epoch with the same id
    for (const e of epochs.values()) { if (!cfgs.has(e.cfg.toBase58()) || e.endSlot < e.startSlot) bad++; }
    for (const [k, c] of cfgs) { if (c.activeEpochAcc) { const e = epochs.get(c.activeEpochAcc.toBase58()); if (e && e.cfg.toBase58() === k && e.epochId === c.activeEpochId) linked++; else bad++; } }
    for (const r_ of bids) { const e = epochs.get(r_.epochAcc.toBase58()); if (e && e.epochId === r_.epochId && e.cfg.equals(r_.cfg) && r_.amount > 0n) bidLinked++; else bad++; }
    ok(bad === 0 && n.rewardCfg > 0 && n.epochState > 0, `parsed ${n.rewardCfg} RewardCfg, ${n.epochState} EpochState, ${n.bidReceipt} BidReceipt (${n.other} closed/other); cross-links consistent (${linked} active cfg→epoch, ${bidLinked} bid→epoch), ${bad} bad`);
  } catch (e) { ok(false, `reward-module scan failed: ${mask(String(e)).slice(0, 120)}`); }

  console.log(`\n${pass} passed, ${fail.length} failed — dex ${dex.toBase58()} ctx ${ctx.toBase58()} lpPortfolio ${pLP.toBase58()}`);
  if (fail.length) { console.log("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
  console.log("PROPAMM DEVNET PROOF OK");
  process.exit(0);
}
main().catch((e) => { console.error(mask(String(e?.stack ?? e)).slice(0, 1500)); console.log(`\n${pass} passed, ${fail.length} failed (ABORTED)`); process.exit(1); });
