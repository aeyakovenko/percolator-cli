/** DEVNET in-place upgrade proof, AFTER phase: FULL UNWIND of every pre-existing (pre-upgrade) account with the FIXED
 *  client (src/lean withLegRefresh / tradeWithMatcherFresh / realizeFlatLegs) on the upgraded (8774e86) program.
 *  Criterion: nothing is stranded — every position can be closed, every portfolio withdrawn to zero and closed, the
 *  insurance withdrawn once OI is 0, rewards claimed, and conservation V==SPL==C+I+R+S+Rew holds after every step.
 *
 *    npx -y tsx scripts/_lean-upgrade-unwind.ts <stage>
 *  stages (run in this order): settle | third | takerk | liq | pair | lp | insurance | final */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  INS_RECEIPT_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE, SIDE,
  initPortfolio, depositCollateral, withdrawCollateral, depositInsurance, withdrawInsurance, trade, liquidate, refreshLeg, closeAccount, clearDeadLeg,
  updateOracle, tradeWithMatcherFresh, withLegRefresh, realizeFlatLegs, claimReward, startWindDown, resolveMarket, sweepSurplus,
  setPortfolioMatcher, parseInsReceipt, deriveDexVault, openLegs, clampPush,
  type VaultAccounts,
} from "../src/lean/index.js";
import {
  conn, funder, guard, send, sim, newAcc, namedKp, outKp, loadMani, snapshot, sleep, U, mkt, pfl, acct, ok, note, fails, notes, pass, cuOf, mask, tokBal, CU,
} from "./_lean-upgrade-lib.js";

const STAGE = process.argv[2] ?? "";
const m = loadMani();
const P = new PublicKey(m.percolator), M = new PublicKey(m.matcher);
const DEX = new PublicKey(m.dex), MKT1 = new PublicKey(m.market), MKT2 = new PublicKey(m.extra.market2), MKT3 = new PublicKey(m.extra.market3);
const MINT = new PublicKey(m.usdc), FTOK = new PublicKey(m.funderToken), FEEV = new PublicKey(m.feeVault);
const V: VaultAccounts = { dex: DEX, mint: MINT, vault: deriveDexVault(P, DEX)[0] };
const CTX = new PublicKey(m.ammVault.ctx), LPP = new PublicKey(m.ammVault.lpPortfolio);
const pflV = new PublicKey(m.prizes.vaultPortfolio), pflU = new PublicKey(m.prizes.userLong), pflC = new PublicKey(m.counterpartyShort);
const pflT = new PublicKey(m.extra.thirdParty), pflC2 = new PublicKey(m.extra.counterparty2), pflK = new PublicKey(m.extra.takerK);
const pflA = new PublicKey(m.extra.victimA), pflB = new PublicKey(m.extra.victimB), pflW = new PublicKey(m.extra.whale);
const O = funder.publicKey;
const tp = namedKp("tp"), cp2 = namedKp("cp2"), takerK = namedKp("takerK"), vicA = namedKp("vicA"), vicB = namedKp("vicB"), whale = namedKp("whale"), rew3 = namedKp("rew3");
const opts = { percolator: P, matcher: M };
const fresh = async (ixs: TransactionInstruction[]) => (await withLegRefresh(conn, ixs, opts)).instructions;

async function conservation(label: string) {
  const s = await snapshot(P, DEX, V.vault);
  ok(s.conserved && s.inv.ok, `${label}: conservation @slot ${s.slot} V=$${U(s.dex.vaultBalance)} C=$${U(s.dex.totalCapital)} I=$${U(s.dex.totalInsurance)} R=$${U(s.dex.totalResidual)} S=$${U(s.dex.totalSurplus)} Rew=$${U(s.dex.totalRewards)} ${s.inv.problems.join("; ")}`);
  return s;
}
const showPfl = async (name: string, k: PublicKey) => { const p = await pfl(k); console.log(`    ${name}: capital $${U(p.capital)} locked $${U(p.totalLockedMm)} legs [${p.legs.map((l) => `${l.sideName} ${l.rawBasis}@m${l.marketId} pnl ${l.posPnl}`).join(", ")}]`); return p; };
const showMkt = async (name: string, k: PublicKey) => { const a = await mkt(k); const raw = await acct(k); console.log(`    ${name}: mark $${U(a.markPrice)} oi ${a.oiLong}/${a.oiShort} raw ${a.rawBasisLong}/${a.rawBasisShort} adl ${a.adlLong}/${a.adlShort} R $${U(a.realizedPool)} P+ $${U(a.totalPosPnl)} ins $${U(a.insurance)} fronted ${a.insFronted} shares ${a.totalInsShares} rew $${U(a.rewardAccrued)} deficitMode ${raw[5]} ${a.statusName}`); return { ...a, deficitMode: raw[5] }; };

/** Close `qty` (default: everything both hold) of a bilateral pair with the FIXED client. */
async function closePair(label: string, market: PublicKey, L: PublicKey, lo: Keypair, S: PublicKey, so: Keypair) {
  const lq = (await pfl(L)).legs.find((l) => l.market.equals(market) && l.side === SIDE.LONG)?.rawBasis ?? 0n;
  const sq = (await pfl(S)).legs.find((l) => l.market.equals(market) && l.side === SIDE.SHORT)?.rawBasis ?? 0n;
  const qty = lq < sq ? lq : sq;
  if (qty === 0n) { note(`${label}: nothing to close (long ${lq}, short ${sq})`); return; }
  const ixs = await fresh([trade(P, { dex: DEX, market, longPortfolio: L, longOwner: lo.publicKey, shortPortfolio: S, shortOwner: so.publicKey, mode: TRADE_MODE.CLOSE, qty })]);
  const sig = await send([CU(), ...ixs], [lo, so]);
  const l2 = (await pfl(L)).legs.find((l) => l.market.equals(market))?.rawBasis ?? 0n, s2 = (await pfl(S)).legs.find((l) => l.market.equals(market))?.rawBasis ?? 0n;
  ok(l2 === lq - qty && s2 === sq - qty, `${label}: closed ${qty} (long ${lq}->${l2}, short ${sq}->${s2}) [${ixs.length} ixs, ${await cuOf(sig)} CU]`);
}
/** Realize flat-leg PnL, withdraw ALL capital to the funder token account, CloseAccount. Asserts nothing is left. */
async function drain(label: string, k: PublicKey, owner: Keypair, expectFlat = true) {
  for (let i = 0; i < 3; i++) {
    const r = await realizeFlatLegs(conn, k, opts);
    if (!r.length) break;
    await send(r);
  }
  let p = await pfl(k);
  if (expectFlat && openLegs(p).length) { ok(false, `${label}: still has open legs ${openLegs(p).map((l) => `${l.sideName} ${l.rawBasis}@m${l.marketId}`).join(",")}`); return 0n; }
  const cap = p.capital; const b0 = await tokBal(FTOK);
  if (cap > 0n) await send([CU(), ...await fresh([withdrawCollateral(P, V, { portfolio: k, owner: owner.publicKey, destToken: FTOK, amount: cap })])], [owner]);
  const got = (await tokBal(FTOK)) - b0;
  p = await pfl(k);
  const stuckPnl = p.legs.reduce((a, l) => a + l.posPnl, 0n);
  ok(got === cap && p.capital === 0n, `${label}: withdrew ALL free capital $${U(cap)} to the owner's token account`);
  if (p.legCount === 0 && p.totalLockedMm === 0n) {
    await send([closeAccount(P, { account: k, authority: owner.publicKey, destination: O })], [owner]);
    ok((await conn.getAccountInfo(k, "confirmed")) === null, `${label}: portfolio closed (CloseAccount, rent returned)`);
  } else ok(false, `${label}: NOT closable — legCount ${p.legCount}, locked $${U(p.totalLockedMm)}, unrealized flat-leg posPnl $${U(stuckPnl)}`);
  return got;
}

// ------------------------------------------------------------------------------------------------ stages
async function settle() {
  // every pre-upgrade leg is settled by the NEW code from its OLD entryK (price + funding accrued before the upgrade)
  const s0 = await conservation("settle start");
  for (const [name, k, mk] of [["userLong", pflU, MKT1], ["cpty short", pflC, MKT1], ["third party MKT1", pflT, MKT1], ["third party MKT2", pflT, MKT2], ["cpty2 MKT1", pflC2, MKT1], ["cpty2 MKT2", pflC2, MKT2],
    ["takerK", pflK, MKT1], ["AMM LP", LPP, MKT1], ["victimA", pflA, MKT3], ["victimB", pflB, MKT3], ["whale", pflW, MKT3]] as const) {
    const p0 = await pfl(k); const leg0 = p0.legs.find((l) => l.market.equals(mk))!;
    const raw0 = await acct(k);
    const sig = await send([refreshLeg(P, { dex: DEX, market: mk, portfolio: k })]);
    const p1 = await pfl(k); const leg1 = p1.legs.find((l) => l.market.equals(mk))!; const raw1 = await acct(k);
    const eq0 = p0.capital + p0.totalLockedMm + p0.legs.reduce((a, l) => a + l.posPnl, 0n), eq1 = p1.capital + p1.totalLockedMm + p1.legs.reduce((a, l) => a + l.posPnl, 0n);
    const mm = await mkt(mk); const kSide = leg1.side === SIDE.LONG ? mm.kLong : mm.kShort;
    // (a leg already touched after the upgrade — e.g. the AMM LP by the post-upgrade smoke fills — is already at the live K)
    ok(leg1.entryK === kSide && leg1.rawBasis === leg0.rawBasis, `RefreshLeg ${name}: ${leg1.entryK !== leg0.entryK ? "pre-upgrade leg settled by 8774e86" : "leg already at the live K"} (entryK ${leg0.entryK - (1n << 62n)} -> ${leg1.entryK - (1n << 62n)}, equity $${U(eq0)} -> $${U(eq1)}, postOracle byte ${raw0[144 + leg0.index * 104 + 3]} -> ${raw1[144 + leg1.index * 104 + 3]}) [${await cuOf(sig)} CU]`);
  }
  await showMkt("MKT1", MKT1); await showMkt("MKT2", MKT2); await showMkt("MKT3", MKT3);
  const s1 = await conservation("settle end");
  ok(s1.dex.vaultBalance === s0.dex.vaultBalance, "refreshing moved no tokens (V unchanged)");
}

async function third() {
  await showPfl("third party", pflT); await showPfl("cpty2", pflC2);
  const b0 = await tokBal(FTOK);
  let sig = await send([CU(), ...await fresh([withdrawCollateral(P, V, { portfolio: pflT, owner: tp.publicKey, destToken: FTOK, amount: 50n * POS_SCALE })])], [tp]);
  ok((await tokBal(FTOK)) - b0 === 50n * POS_SCALE, `MULTI-LEG third party withdrew $50 with open legs on 2 markets (fixed client) [${await cuOf(sig)} CU]`);
  await conservation("after multi-leg withdraw");
  const q0 = (await pfl(pflT)).legs.find((l) => l.market.equals(MKT1))!.rawBasis;
  sig = await send([CU(), ...await fresh([trade(P, { dex: DEX, market: MKT1, longPortfolio: pflT, longOwner: tp.publicKey, shortPortfolio: pflC2, shortOwner: cp2.publicKey, mode: TRADE_MODE.OPEN, qty: 100n })])], [tp, cp2]);
  ok((await pfl(pflT)).legs.find((l) => l.market.equals(MKT1))!.rawBasis === q0 + 100n, `MULTI-LEG bilateral OPEN +0.0001 on MKT1 (fixed client) [${await cuOf(sig)} CU]`);
  await conservation("after multi-leg bilateral open");
  const m1 = await mkt(MKT1);
  for (const buy of [true, false]) {
    const ixs = await tradeWithMatcherFresh(conn, P, { dex: DEX, takerPortfolio: pflT, taker: tp.publicKey, lpPortfolio: LPP, matcherProgram: M, matcherCtx: CTX,
      legs: [{ market: MKT1, mode: TRADE_MODE.NETTED, takerIsLong: buy, maxQty: 100n, limitPrice: buy ? m1.markPrice + m1.markPrice / 50n : m1.markPrice - m1.markPrice / 50n }] });
    const a = (await pfl(pflT)).legs.find((l) => l.market.equals(MKT1))!.rawBasis;
    sig = await send([CU(), ...ixs], [tp]);
    const b = (await pfl(pflT)).legs.find((l) => l.market.equals(MKT1))!.rawBasis;
    ok(b - a === (buy ? 100n : -100n), `MULTI-LEG third party ${buy ? "bought" : "sold"} 0.0001 vs the AMM vault with tradeWithMatcherFresh (3-account matcher CPI: ctx + trailing market + LP portfolio) [${ixs.length} ixs, ${await cuOf(sig)} CU]`);
  }
  await conservation("after multi-leg AMM trades");
  await closePair("third party / cpty2 MKT1", MKT1, pflT, tp, pflC2, cp2);
  await closePair("third party / cpty2 MKT2", MKT2, pflT, tp, pflC2, cp2);
  await conservation("after closing the multi-leg pair");
  const g1 = await drain("third party", pflT, tp), g2 = await drain("cpty2", pflC2, cp2);
  console.log(`    third party got back $${U(g1 + 50n * POS_SCALE)} of $500, cpty2 $${U(g2)} of $500 (PnL is zero-sum between them, minus fees/funding)`);
  await conservation("after draining the multi-leg pair");
}

async function takerk() {
  await showPfl("takerK", pflK); await showPfl("AMM LP", LPP);
  const m1 = await mkt(MKT1);
  const ixs = await tradeWithMatcherFresh(conn, P, { dex: DEX, takerPortfolio: pflK, taker: takerK.publicKey, lpPortfolio: LPP, matcherProgram: M, matcherCtx: CTX,
    legs: [{ market: MKT1, mode: TRADE_MODE.NETTED, takerIsLong: false, maxQty: 100n, limitPrice: m1.markPrice - m1.markPrice / 50n }] });
  const sig = await send([CU(), ...ixs], [takerK]);
  ok(openLegs(await pfl(pflK)).length === 0 && openLegs(await pfl(LPP)).length === 0, `pre-upgrade taker K closed its long against the AMM vault -> taker AND vault flat [${await cuOf(sig)} CU]`);
  await drain("takerK", pflK, takerK);
  await conservation("after takerK close-out");
}

async function liq() {
  const oracle3 = outKp("oracle3");
  // insurance on the sacrificial market first (mainnet-like: an LP that must still get out after a bankruptcy)
  const rc3 = await newAcc(INS_RECEIPT_SIZE, P);
  await send([depositInsurance(P, V, { market: MKT3, receipt: rc3, lp: O, sourceToken: FTOK, amount: 5n * POS_SCALE })]);
  m.extra.insReceipt3 = rc3.toBase58(); (await import("./_lean-upgrade-lib.js")).saveMani(m);
  await showMkt("MKT3", MKT3); await showPfl("victimA", pflA); await showPfl("victimB", pflB); await showPfl("whale", pflW);
  const push = async (toward: bigint) => {
    const a = await mkt(MKT3); const slot = BigInt(await conn.getSlot("confirmed"));
    const px = clampPush(a.markPrice, toward, a.maxMoveBps, slot - a.lastOracleSlot);
    await send([updateOracle(P, { market: MKT3, oracleAuth: oracle3.publicKey, price: px })], [oracle3]);
    await sleep(900);
    return px;
  };
  // ---- 1. SOLVENT liquidation of victim A (under maintenance margin, still has equity)
  let liqA = false;
  for (let i = 0; i < 40 && !liqA; i++) {
    const px = await push(90n * POS_SCALE);
    const ixs = await fresh([liquidate(P, V, { market: MKT3, portfolio: pflA, liquidatorToken: FTOK })]);
    const r = await sim(ixs);
    if (i % 3 === 0 || r.ok) console.log(`    mark $${U(px)}: liquidate(victimA) sim -> ${r.name}`);
    if (r.ok) {
      const b0 = await tokBal(FTOK); const pa0 = await pfl(pflA);
      const sig = await send([CU(), ...ixs]);
      const pa1 = await showPfl("victimA after", pflA);
      ok(openLegs(pa1).length < openLegs(pa0).length || (pa1.legs[0]?.rawBasis ?? 0n) < pa0.legs[0].rawBasis, `LIQUIDATION of the under-margined pre-upgrade position at mark $${U(px)} (liquidator fee $${U((await tokBal(FTOK)) - b0)}) [${await cuOf(sig)} CU]`);
      liqA = true;
    } else if (r.code !== 116) { note(`liquidate(victimA) sim at $${U(px)}: ${r.name}`); }
  }
  ok(liqA, "victim A was liquidated");
  await showMkt("MKT3", MKT3);
  await conservation("after solvent liquidation");
  // ---- 2. BANKRUPT liquidation of victim B (loss > equity) => unfronted bad debt => deficit mode
  let bankrupt = false;
  for (let i = 0; i < 60 && !bankrupt; i++) {
    const px = await push(80n * POS_SCALE);
    const r = await sim([refreshLeg(P, { dex: DEX, market: MKT3, portfolio: pflB })]);
    if (i % 4 === 0 || !r.ok) console.log(`    mark $${U(px)}: RefreshLeg(victimB) sim -> ${r.name}`);
    if (!r.ok && r.code === 107) bankrupt = true;
  }
  ok(bankrupt, "victim B is bankrupt (RefreshLeg rejects with insufficientMargin 107)");
  {
    const ixs = await fresh([liquidate(P, V, { market: MKT3, portfolio: pflB, liquidatorToken: FTOK })]);
    const r = await sim(ixs);
    console.log(`    liquidate(victimB, bankrupt) sim -> ${r.name}`);
    const mk0 = await showMkt("MKT3 before", MKT3);
    const sig = await send([CU(), ...ixs]);
    const mk1 = await showMkt("MKT3 after ", MKT3);
    await showPfl("victimB after", pflB);
    ok(openLegs(await pfl(pflB)).length === 0, `BANKRUPT liquidation of victim B executed [${await cuOf(sig)} CU]; insurance $${U(mk0.insurance)} -> $${U(mk1.insurance)}, deficitMode ${mk0.deficitMode} -> ${mk1.deficitMode}`);
    if (mk1.deficitMode === 1) {
      const o = await sim(await fresh([trade(P, { dex: DEX, market: MKT3, longPortfolio: pflV, longOwner: O, shortPortfolio: pflW, shortOwner: whale.publicKey, mode: TRADE_MODE.OPEN, qty: 1000n })]));
      ok(o.code === 115, `deficit mode latched: a NEW open on this market is rejected — ${o.name}`);
    } else note("deficit mode did NOT latch on this bankruptcy (bad debt fully covered)");
  }
  await conservation("after bankrupt liquidation");
  // ---- 3. the winner (whale short) gets out; deficit mode must clear and nothing may be stranded
  await showPfl("whale", pflW);
  const rw = await sim([refreshLeg(P, { dex: DEX, market: MKT3, portfolio: pflW })]);
  console.log(`    RefreshLeg(whale) sim -> ${rw.name}`);
  if (rw.ok) { await send([refreshLeg(P, { dex: DEX, market: MKT3, portfolio: pflW })]); await showPfl("whale after refresh", pflW); await showMkt("MKT3", MKT3); }
  const wq = (await pfl(pflW)).legs.find((l) => l.market.equals(MKT3));
  if (wq && wq.rawBasis > 0n) {
    const cd = await sim([clearDeadLeg(P, { dex: DEX, market: MKT3, portfolio: pflW })]);
    console.log(`    ClearDeadLeg(whale) sim -> ${cd.name}`);
    if (cd.ok) { await send([clearDeadLeg(P, { dex: DEX, market: MKT3, portfolio: pflW })]); ok(true, "whale's fully-ADL'd short cleared with ClearDeadLeg (side OI is 0)"); }
    else ok(false, `whale leg cannot be cleared: ${cd.name}`);
  }
  await showPfl("whale after clear", pflW);
  const mkC = await showMkt("MKT3 after whale exit", MKT3);
  await conservation("after whale exit");
  for (const [n, k, o] of [["victimA", pflA, vicA], ["victimB", pflB, vicB], ["whale", pflW, whale]] as const) await drain(n, k, o);
  const mkD = await showMkt("MKT3 all flat", MKT3);
  ok(mkD.deficitMode === 0, `deficit mode cleared once every leg is flat (was ${mkC.deficitMode})`);
  ok(mkD.oiLong === 0n && mkD.rawBasisLong === 0n && mkD.rawBasisShort === 0n, "MKT3: zero OI / raw basis");
  // insurance LP of the bankrupt market gets its remaining share out
  const sh = parseInsReceipt(await acct(rc3)).shares; const b0 = await tokBal(FTOK);
  await send([withdrawInsurance(P, V, { market: MKT3, receipt: rc3, lp: O, destToken: FTOK, burnShares: sh })]);
  const got = (await tokBal(FTOK)) - b0; const mkE = await showMkt("MKT3 after insurance withdraw", MKT3);
  ok(parseInsReceipt(await acct(rc3)).shares === 0n && mkE.insurance === 0n, `insurance LP of the sacrificial market withdrew everything left after the bankruptcy: $${U(got)} of $5 deposited (the rest absorbed bad debt)`);
  await send([closeAccount(P, { account: rc3, authority: O, destination: O })]);
  // reward fees of MKT3 (recipient = plain key)
  if (mkE.rewardAccrued > 0n) {
    const b1 = await tokBal(FTOK);
    await send([claimReward(P, V, { market: MKT3, rewardAuth: rew3.publicKey, destToken: FTOK })], [rew3]);
    ok((await tokBal(FTOK)) - b1 === mkE.rewardAccrued, `ClaimReward (op 21) paid MKT3's accrued reward fees $${U(mkE.rewardAccrued)}`);
  }
  const mkF = await showMkt("MKT3 final", MKT3);
  if (mkF.realizedPool > 0n || mkF.totalPosPnl > 0n) note(`MKT3 residue: realizedPool $${U(mkF.realizedPool)}, totalPosPnl $${U(mkF.totalPosPnl)}`);
  await conservation("after sacrificial-market unwind");
}

async function pair() {
  await showPfl("userLong", pflU); await showPfl("cpty short", pflC);
  {
    // CHANGED FEE ROUTING (8774e86 creditTradeFee): on a market with built-in funding the non-reward part of the trade
    // fee goes to protocol surplus S instead of the market's insurance. MKT2 = funding on, rewardBps 0 -> 100% to S.
    // (MKT1 / mainnet = rewardBps 10000 -> 100% to the reward accrual, unchanged; shown by the live smoke.)
    const s0 = await snapshot(P, DEX, V.vault); const a0 = s0.markets.get(MKT2.toBase58())!;
    await send([CU(), ...await fresh([trade(P, { dex: DEX, market: MKT2, longPortfolio: pflU, longOwner: O, shortPortfolio: pflC, shortOwner: O, mode: TRADE_MODE.OPEN, qty: 100_000n })])]);
    const s1 = await snapshot(P, DEX, V.vault); const a1 = s1.markets.get(MKT2.toBase58())!;
    const dS = s1.dex.totalSurplus - s0.dex.totalSurplus, dI = a1.insurance - a0.insurance;
    ok(dS > 0n && dI === 0n && a1.rewardAccrued === a0.rewardAccrued, `fee routing on a funded market with rewardBps 0 (MKT2): trade fee +$${U(dS)} went to protocol SURPLUS, insurance +$${U(dI)} (887ba02 sent it to insurance)`);
    ok((await pfl(pflU)).legs.filter((l) => l.rawBasis > 0n).length === 2, "prize-3 portfolio is now MULTI-LEG (MKT1 + MKT2)");
    await closePair("prize pair MKT2", MKT2, pflU, funder, pflC, funder);
  }
  await closePair("prize-3 long / counterparty short", MKT1, pflU, funder, pflC, funder);
  await conservation("after closing the prize pair");
  const a = await drain("userLong (prize 3)", pflU, funder), b = await drain("counterparty short", pflC, funder), c = await drain("vault portfolio (prize 2)", pflV, funder);
  console.log(`    prize-3 $${U(a)} of $23, counterparty $${U(b)} of $25 (sum $${U(a + b)} of $48), prize-2 $${U(c)} of $23`);
  ok(c === 23n * POS_SCALE, "prize-2 loose collateral withdrawn in full: $23.000000");
  await conservation("after draining the prize portfolios");
}

async function lp() {
  const p = await showPfl("AMM LP", LPP);
  if (openLegs(p).length) { ok(false, "AMM LP still holds inventory"); return; }
  await send([setPortfolioMatcher(P, { portfolio: LPP, owner: O, matcherCtx: null })]);
  ok((await pfl(LPP)).matcherCtx.equals(PublicKey.default), "AMM LP unbound from its matcher ctx (SetPortfolioMatcher null)");
  const got = await drain("AMM LP portfolio", LPP, funder);
  console.log(`    AMM LP got back $${U(got)} of $10 deposited`);
  await conservation("after AMM LP withdraw");
}

async function insurance() {
  const a = await showMkt("MKT1", MKT1);
  ok(a.oiLong === 0n && a.rawBasisLong === 0n && a.rawBasisShort === 0n, "MKT1 has zero OI / raw basis (every position closed)");
  const s = await snapshot(P, DEX, V.vault);
  let total = 0n;
  for (const [k, r] of s.receipts) {
    if (!r.market.equals(MKT1) || r.shares === 0n) continue;
    const b0 = await tokBal(FTOK);
    await send([withdrawInsurance(P, V, { market: MKT1, receipt: new PublicKey(k), lp: r.owner, destToken: FTOK, burnShares: r.shares })]);
    const got = (await tokBal(FTOK)) - b0; total += got;
    ok(parseInsReceipt(await acct(new PublicKey(k))).shares === 0n && got > 0n, `insurance receipt ${k.slice(0, 8)}… burned ${r.shares} shares -> $${U(got)}`);
    await send([closeAccount(P, { account: new PublicKey(k), authority: r.owner, destination: O })]);
  }
  const b = await showMkt("MKT1 after", MKT1);
  ok(b.insurance === 0n && total >= 25n * POS_SCALE - 2n, `ALL MKT1 insurance withdrawn by its LPs: $${U(total)} (deposited $23 prize + $2 test)`);
  await conservation("after insurance withdraw");
}

async function final() {
  // MKT2: fees paid before the upgrade sit in its (LP-less) insurance, fees after the upgrade went to surplus S.
  for (const [n, k] of [["MKT2", MKT2], ["MKT3", MKT3]] as const) {
    const a = await showMkt(n, k);
    if (a.statusName === "Active" && (a.insurance > 0n || a.realizedPool > 0n)) {
      await send([startWindDown(P, { market: k, caller: O })]);
      for (let i = 0; i < 30; i++) { const r = await sim([resolveMarket(P, { dex: DEX, market: k })]); if (r.ok) break; await sleep(2000); }
      await send([resolveMarket(P, { dex: DEX, market: k })]);
      await showMkt(`${n} resolved`, k);
    }
  }
  let s = await conservation("before sweep");
  if (s.dex.totalSurplus > 0n) {
    const b0 = await tokBal(FEEV);
    await send([sweepSurplus(P, V, { admin: O, feeVault: FEEV })]);
    ok((await tokBal(FEEV)) - b0 === s.dex.totalSurplus, `SweepSurplus moved S = $${U(s.dex.totalSurplus)} to the fee vault`);
  }
  s = await conservation("final");
  const d = s.dex;
  console.log(`    portfolios left: ${s.portfolios.size}; receipts with shares: ${[...s.receipts.values()].filter((r) => r.shares > 0n).length}`);
  for (const [k, p] of s.portfolios) console.log(`    LEFT portfolio ${k}: capital $${U(p.capital)} locked $${U(p.totalLockedMm)} legs ${p.legs.length}`);
  ok(d.totalCapital === 0n, `C == 0: every portfolio's collateral was withdrawn (C=$${U(d.totalCapital)})`);
  ok(d.totalInsurance === 0n, `I == 0: all insurance withdrawn / swept (I=$${U(d.totalInsurance)})`);
  ok(d.totalSurplus === 0n, `S == 0 after the sweep`);
  const quoteVault = await tokBal(new PublicKey(m.quoteVault));
  const fTok = await tokBal(FTOK), feeV = await tokBal(FEEV);
  const minted = BigInt(m.minted);
  console.log(`    token accounting: funder $${U(fTok)} + feeVault $${U(feeV)} + reward quoteVault $${U(quoteVault)} + DEX vault $${U(s.spl)} = $${U(fTok + feeV + quoteVault + s.spl)} (minted $${U(minted)})`);
  ok(fTok + feeV + quoteVault + s.spl === minted, "no token created or lost: funder + feeVault + reward module + DEX vault == minted supply");
  console.log(`    what is still in the DEX vault: R=$${U(d.totalResidual)} (rounding dust / unclaimed realized pool), Rew=$${U(d.totalRewards)} (reward fees waiting for the reward-module epoch)`);
  for (const k of [MKT1, MKT2, MKT3]) await showMkt(k.toBase58().slice(0, 6), k);
}

async function main() {
  await guard();
  console.log(`=== upgrade-proof UNWIND stage "${STAGE}" on ${P.toBase58()} ===`);
  const stages: Record<string, () => Promise<void>> = { settle, third, takerk, liq, pair, lp, insurance, final };
  if (!stages[STAGE]) throw new Error(`stage: ${Object.keys(stages).join(" | ")}`);
  await stages[STAGE]();
  console.log(`\nUNWIND ${STAGE}: ${pass} ok, ${fails.length} failed${notes.length ? `, ${notes.length} notes` : ""}`);
  if (fails.length) { console.log("FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", mask(String((e as Error).stack ?? e)).slice(0, 1500)); process.exit(1); });
