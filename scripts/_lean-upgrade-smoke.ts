/** DEVNET in-place upgrade proof: BEFORE/AFTER smoke on the mirrored mainnet round-4 state (see _lean-upgrade-setup.ts).
 *
 *   npx -y tsx scripts/_lean-upgrade-smoke.ts probe <tag>   # simulation-only matrix (nothing lands) + parse + conservation
 *   npx -y tsx scripts/_lean-upgrade-smoke.ts live  <tag>   # real txs with FRESH accounts + keeper / reward / monitor scripts
 *
 * `probe` runs every instruction x portfolio shape in three account shapes and records the exact result + CU:
 *   pub    = what the PUBLISHED client sends: RefreshLeg for every open leg + the bare instruction;
 *   trail  = the same + the Market accounts of the portfolio's open legs appended as trailing read-only accounts;
 *   client = the builders of src/lean AS THEY ARE IN THIS TREE (withLegRefresh / tradeWithMatcherFresh).
 * Results go to $OUT_DIR/probe-<tag>.json so before/after can be diffed. Existing accounts are NEVER mutated by `probe`. */
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, EPOCH_SIZE, POS_SCALE, TRADE_MODE, K_ZERO,
  createMarket, initPortfolio, depositCollateral, withdrawCollateral, depositInsurance, withdrawInsurance, trade, liquidate, refreshLeg,
  closeAccount, updateOracle, tradeWithMatcher, tradeWithMatcherFresh, withLegRefresh, rewardStartEpoch, packFundingCfg,
  parsePropAmmCtx, parseRewardCfg, parseInsReceipt, propAmmQuote, deriveDexVault, openLegs,
  type VaultAccounts,
} from "../src/lean/index.js";
import {
  conn, funder, guard, PROG, send, sim, newAcc, namedKp, outKp, loadMani, MANI_PATH, OUT_DIR, RPC, snapshot, refreshOnly, withTrailing, legMarkets,
  sleep, U, mkt, pfl, acct, ok, note, fails, notes, pass, cuOf, mask, type SimResult,
} from "./_lean-upgrade-lib.js";

const MODE = process.argv[2] ?? "probe", TAG = process.argv[3] ?? "run";
const m = loadMani();
const P = new PublicKey(m.percolator), M = new PublicKey(m.matcher), RM = new PublicKey(m.rewardModule);
const DEX = new PublicKey(m.dex), MKT1 = new PublicKey(m.market), MKT2 = new PublicKey(m.extra.market2), MKT3 = new PublicKey(m.extra.market3);
const MINT = new PublicKey(m.usdc), FTOK = new PublicKey(m.funderToken);
const V: VaultAccounts = { dex: DEX, mint: MINT, vault: deriveDexVault(P, DEX)[0] };
const CTX = new PublicKey(m.ammVault.ctx), LPP = new PublicKey(m.ammVault.lpPortfolio);
const pflV = new PublicKey(m.prizes.vaultPortfolio), pflU = new PublicKey(m.prizes.userLong), pflC = new PublicKey(m.counterpartyShort);
const pflT = new PublicKey(m.extra.thirdParty), pflC2 = new PublicKey(m.extra.counterparty2), pflK = new PublicKey(m.extra.takerK);
const O = funder.publicKey;
const tp = namedKp("tp"), cp2 = namedKp("cp2"), takerK = namedKp("takerK");
const opts = { percolator: P, matcher: M };

async function conservation(label: string) {
  const s = await snapshot(P, DEX, V.vault);
  ok(s.conserved && s.inv.ok, `${label}: conservation V==SPL==C+I+R+S+Rew @slot ${s.slot} V=$${U(s.dex.vaultBalance)} C=$${U(s.dex.totalCapital)} I=$${U(s.dex.totalInsurance)} R=$${U(s.dex.totalResidual)} S=$${U(s.dex.totalSurplus)} Rew=$${U(s.dex.totalRewards)} ${s.inv.problems.join("; ")}`);
  return s;
}

// =================================================================================================== probe
async function probe() {
  const rows: { label: string; variant: string; result: string; cu: number }[] = [];
  const rec = (label: string, variant: string, r: SimResult) => { rows.push({ label, variant, result: r.name, cu: r.cu }); console.log(`  ${label.padEnd(52)} ${variant.padEnd(7)} ${r.name.padEnd(28)} ${r.cu} CU`); return r; };
  /** pub / trail / client for an instruction that needs the open legs of `pfls` fresh. */
  const three = async (label: string, ix: TransactionInstruction, pfls: PublicKey[], clientIxs?: TransactionInstruction[]) => {
    const refresh = await refreshOnly(P, DEX, pfls);
    rec(label, "pub", await sim([...refresh, ix]));
    rec(label, "trail", await sim([...refresh, withTrailing(ix, await legMarkets(pfls))]));
    rec(label, "client", await sim(clientIxs ?? (await withLegRefresh(conn, [ix], opts)).instructions));
  };
  const s0 = await conservation(`probe[${TAG}] start`);
  // every pre-existing account parses with the CURRENT client (snapshot() parsed them all) — spot check the raw new bytes
  const rawM = await acct(MKT1); const rawU = await acct(pflU);
  console.log(`  Market byte5 (deficitMode) = ${rawM[5]}; userLong leg0 byte3 (postOracle) = ${rawU[144 + 3]}; accounts parsed: ${s0.markets.size} markets, ${s0.portfolios.size} portfolios, ${s0.receipts.size} receipts`);
  const ctx = parsePropAmmCtx(await acct(CTX)); parseRewardCfg(await acct(new PublicKey(m.rewardCfg))); parseInsReceipt(await acct(new PublicKey(m.insReceipt)));
  ok(ctx.owner.equals(O) && (await pfl(LPP)).matcherCtx.equals(CTX), "PropAMM ctx + reward cfg + insurance receipt parse; LP bound to ctx");
  const m1 = await mkt(MKT1);
  const lim = (buy: boolean) => (buy ? m1.markPrice + m1.markPrice / 50n : m1.markPrice - m1.markPrice / 50n);
  const usd1 = POS_SCALE;

  console.log("== WithdrawCollateral ==");
  rec("withdraw $1 FLAT (prize-2 vault pfl)", "plain", await sim([withdrawCollateral(P, V, { portfolio: pflV, owner: O, destToken: FTOK, amount: usd1 })]));
  await three("withdraw $1 SINGLE-LEG (prize-3 userLong)", withdrawCollateral(P, V, { portfolio: pflU, owner: O, destToken: FTOK, amount: usd1 }), [pflU]);
  await three("withdraw $1 MULTI-LEG (third party)", withdrawCollateral(P, V, { portfolio: pflT, owner: tp.publicKey, destToken: FTOK, amount: usd1 }), [pflT]);
  await three("withdraw $1 AMM LP (holds inventory)", withdrawCollateral(P, V, { portfolio: LPP, owner: O, destToken: FTOK, amount: usd1 }), [LPP]);

  console.log("== Trade (bilateral, op 11) ==");
  const tU = (mode: number, qty: bigint, execPrice?: bigint) => trade(P, { dex: DEX, market: MKT1, longPortfolio: pflU, longOwner: O, shortPortfolio: pflC, shortOwner: O, mode, qty, execPrice });
  const tT = (market: PublicKey, mode: number, qty: bigint, execPrice?: bigint) => trade(P, { dex: DEX, market, longPortfolio: pflT, longOwner: tp.publicKey, shortPortfolio: pflC2, shortOwner: cp2.publicKey, mode, qty, execPrice });
  await three("OPEN +0.00001 single-leg pair (userLong/cpty)", tU(TRADE_MODE.OPEN, 10n), [pflU, pflC]);
  await three("CLOSE 0.00001 single-leg pair at mark", tU(TRADE_MODE.CLOSE, 10n), [pflU, pflC]);
  rec("CLOSE 0.00001 single-leg pair at mark", "bare", await sim([tU(TRADE_MODE.CLOSE, 10n)]));
  await three("OPEN +0.00001 MULTI-LEG pair on MKT1", tT(MKT1, TRADE_MODE.OPEN, 10n), [pflT, pflC2]);
  await three("NETTED(4) +0.00001 MULTI-LEG pair on MKT1", tT(MKT1, TRADE_MODE.NETTED, 10n), [pflT, pflC2]);
  await three("CLOSE 0.00001 MULTI-LEG pair at mark", tT(MKT1, TRADE_MODE.CLOSE, 10n), [pflT, pflC2]);
  rec("CLOSE 0.00001 MULTI-LEG pair at mark", "bare", await sim([tT(MKT1, TRADE_MODE.CLOSE, 10n)]));
  await three("CLOSE 0.00001 MULTI-LEG pair OFF-mark (+0.1%)", tT(MKT1, TRADE_MODE.CLOSE, 10n, m1.markPrice + m1.markPrice / 1000n), [pflT, pflC2]);
  rec("CLOSE 0.00001 MULTI-LEG pair OFF-mark (+0.1%)", "bare", await sim([tT(MKT1, TRADE_MODE.CLOSE, 10n, m1.markPrice + m1.markPrice / 1000n)]));

  console.log("== TradeWithMatcher (op 23) vs the PropAMM vault ==");
  const twm = (takerPortfolio: PublicKey, taker: PublicKey, buy: boolean, qty = 100n) => ({ dex: DEX, takerPortfolio, taker, lpPortfolio: LPP, matcherProgram: M, matcherCtx: CTX,
    legs: [{ market: MKT1, mode: TRADE_MODE.NETTED, takerIsLong: buy, maxQty: qty, limitPrice: lim(buy) }] });
  for (const [label, tpf, owner, buy] of [
    ["FLAT taker buys 0.0001 (prize-2 pfl, sim only)", pflV, O, true], ["SINGLE-LEG taker K sells 0.0001 (closes)", pflK, takerK.publicKey, false],
    ["SINGLE-LEG taker (userLong) buys 0.0001", pflU, O, true], ["MULTI-LEG taker (third party) buys 0.0001", pflT, tp.publicKey, true],
    ["MULTI-LEG taker (third party) sells 0.0001", pflT, tp.publicKey, false],
  ] as const) {
    const a = twm(tpf, owner, buy);
    await three(label, tradeWithMatcher(P, a), [tpf, LPP], await tradeWithMatcherFresh(conn, P, a));
  }

  console.log("== Liquidate (op 12) on HEALTHY positions (must be rejected) ==");
  const liq = (market: PublicKey, portfolio: PublicKey) => liquidate(P, V, { market, portfolio, liquidatorToken: FTOK });
  rec("liquidate healthy single-leg (userLong)", "bare", await sim([liq(MKT1, pflU)]));
  rec("liquidate healthy MULTI-LEG third party on MKT1", "bare", await sim([liq(MKT1, pflT)]));
  rec("liquidate healthy MULTI-LEG third party on MKT1", "pub", await sim([refreshLeg(P, { dex: DEX, market: MKT2, portfolio: pflT }), liq(MKT1, pflT)]));
  rec("liquidate healthy MULTI-LEG third party on MKT1", "trail", await sim([refreshLeg(P, { dex: DEX, market: MKT2, portfolio: pflT }), withTrailing(liq(MKT1, pflT), [MKT2])]));
  rec("liquidate healthy MULTI-LEG third party on MKT1", "client", await sim((await withLegRefresh(conn, [refreshLeg(P, { dex: DEX, market: MKT2, portfolio: pflT }), liq(MKT1, pflT)], opts)).instructions));

  console.log("== other instructions on pre-existing accounts ==");
  rec("RefreshLeg userLong (settles pre-upgrade entryK)", "bare", await sim([refreshLeg(P, { dex: DEX, market: MKT1, portfolio: pflU })]));
  rec("RefreshLeg third party MKT2", "bare", await sim([refreshLeg(P, { dex: DEX, market: MKT2, portfolio: pflT })]));
  rec("RefreshLeg AMM LP", "bare", await sim([refreshLeg(P, { dex: DEX, market: MKT1, portfolio: LPP })]));
  rec("DepositCollateral $1 -> userLong", "bare", await sim([depositCollateral(P, V, { portfolio: pflU, depositor: O, sourceToken: FTOK, amount: usd1 })]));
  rec("DepositInsurance $1 (existing receipt, mints shares)", "bare", await sim([depositInsurance(P, V, { market: MKT1, receipt: new PublicKey(m.insReceipt), lp: O, sourceToken: FTOK, amount: usd1 })]));
  rec("DepositInsurance $1 donate", "bare", await sim([depositInsurance(P, V, { market: MKT1, receipt: new PublicKey(m.insReceipt), lp: O, sourceToken: FTOK, amount: usd1, donate: true })]));
  rec("WithdrawInsurance 1 share with OI open (expect 118)", "bare", await sim([withdrawInsurance(P, V, { market: MKT1, receipt: new PublicKey(m.insReceipt), lp: O, destToken: FTOK, burnShares: 1n })]));
  rec("CloseAccount non-empty userLong (expect 119)", "bare", await sim([closeAccount(P, { account: pflU, authority: O, destination: O })]));
  rec("UpdateOracle MKT1 (same price)", "bare", await sim([updateOracle(P, { market: MKT1, oracleAuth: new PublicKey(m.oracleAuth), price: m1.markPrice })]));
  {
    const ep = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(EPOCH_SIZE);
    rec("reward StartEpoch (CPI ClaimReward of accrued fees)", "bare", await sim([SystemProgram.createAccount({ fromPubkey: O, newAccountPubkey: ep.publicKey, lamports: lam, space: EPOCH_SIZE, programId: RM }),
      rewardStartEpoch(RM, { cfg: new PublicKey(m.rewardCfg), epochAcc: ep.publicKey, dex: DEX, market: MKT1, quoteMint: MINT, dexVault: V.vault, quoteVault: new PublicKey(m.quoteVault), percolator: P })]));
  }
  {
    // discriminating probe: the mainnet market config (built-in funding + rewardBps 10000) — accepted by 887ba02, rejected (103) by 8774e86
    const nm = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(MARKET_SIZE);
    const base = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n,
      fundingCfg: packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 }) };
    const mk = (extra: object) => [SystemProgram.createAccount({ fromPubkey: O, newAccountPubkey: nm.publicKey, lamports: lam, space: MARKET_SIZE, programId: P }),
      createMarket(P, { dex: DEX, market: nm.publicKey, mint: MINT, oracleAuth: O, creator: O, creatorToken: FTOK, feeVault: new PublicKey(m.feeVault), params: { ...base, ...extra } })];
    rec("CreateMarket mainnet cfg (funding + rewardBps 10000)", "bare", await sim(mk({ rewardBps: 10000n, rewardRecipient: new PublicKey(m.rewAuth) })));
    rec("CreateMarket funding + rewardBps 0", "bare", await sim(mk({})));
    rec("CreateMarket funding + rewardBps 5000 (decay 720)", "bare", await sim(mk({ rewardBps: 5000n, rewardRecipient: new PublicKey(m.rewAuth), fundingCfg: packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 720 }) })));
    rec("CreateMarket no funding + rewardBps 10000", "bare", await sim(mk({ rewardBps: 10000n, rewardRecipient: new PublicKey(m.rewAuth), fundingCfg: 0n })));
  }
  const s1 = await conservation(`probe[${TAG}] end`);
  ok(s1.dex.vaultBalance === s0.dex.vaultBalance && s1.dex.totalCapital === s0.dex.totalCapital, "probe mutated nothing (V and C unchanged)");
  fs.writeFileSync(`${OUT_DIR}/probe-${TAG}.json`, JSON.stringify(rows, null, 1) + "\n");
  console.log(`probe rows -> ${OUT_DIR}/probe-${TAG}.json`);
}

// =================================================================================================== live
function runScript(label: string, file: string, args: string[], env: Record<string, string>, timeoutMs = 120_000) {
  if (loadMani().percolator !== PROG.percolator.toBase58() || !RPC.includes("devnet")) throw new Error("refusing: manifest/RPC is not the fresh devnet deployment");
  const r = spawnSync("npx", ["-y", "tsx", file, ...args], { encoding: "utf8", timeout: timeoutMs,
    env: { ...process.env, LEAN_MANIFEST: MANI_PATH, LEAN_RPC_URL: RPC, SOLANA_RPC_URL: RPC, ORACLE_KEYPAIR: `${OUT_DIR}/oracle-keypair.json`, REWARD_BID_STATE_FILE: `${OUT_DIR}/reward-bid-state.json`, ...env } });
  // a timed-out `npx tsx` leaves its node grandchild behind: reap OUR copy only (the pattern includes this worktree's path)
  spawnSync("pkill", ["-f", `${process.cwd()}/node_modules/.bin/../tsx/dist/cli.mjs ${file}`]);
  const out = mask(`${r.stdout ?? ""}${r.stderr ?? ""}`).split("\n").filter((l) => l.trim() && !/npm warn/.test(l));
  console.log(out.map((l) => `    | ${l.slice(0, 260)}`).join("\n"));
  return { status: r.status, out: out.join("\n"), label };
}
async function live() {
  const s0 = await conservation(`live[${TAG}] start`);
  const mk0 = s0.markets.get(MKT1.toBase58())!;
  const ins0 = mk0.insurance;
  // ---- keeper oracle push (the real mainnet keeper script, pointed at devnet)
  // (the keeper script has no explicit process.exit and lingers on its confirmation websocket on devnet — on BOTH
  //  program versions — so it runs under a 45 s timeout and is judged by its output + the on-chain effect)
  const k = runScript("oracle keeper", "scripts/_lean-r4-crank.ts", [], {}, 45_000);
  const mk1 = await mkt(MKT1);
  if (k.status !== 0) note(`keeper script did not exit by itself within 45 s after its push landed (exit ${k.status}); same on 887ba02 and 8774e86`);
  ok(/cranked BTC/.test(k.out) && !/Error|ERR/.test(k.out) && mk1.lastOracleSlot > mk0.lastOracleSlot, `oracle keeper pushed: mark $${U(mk0.markPrice)} -> $${U(mk1.markPrice)} (lastOracleSlot ${mk0.lastOracleSlot} -> ${mk1.lastOracleSlot})`);
  const fundingAccrued = (mk1.markPrice - BigInt(m.initPrice)) - (mk1.kLong - K_ZERO);
  ok(fundingAccrued > 0n, `built-in funding accrued so far (longs pay): ${fundingAccrued} E6 per 1.0 base (K_long lags the mark move by that much)`);
  await conservation("after keeper push");

  // ---- fresh single-signer taker vs the AMM vault (mirrors lean-mainnet-r4-amm.ts), with the CURRENT client builder
  const taker = Keypair.generate();
  const TP = await newAcc(PORTFOLIO_SIZE, P);
  await send([initPortfolio(P, { dex: DEX, portfolio: TP, owner: taker.publicKey })], [taker]);
  await send([depositCollateral(P, V, { portfolio: TP, depositor: O, sourceToken: FTOK, amount: 5n * POS_SCALE })]);
  const lpValue = (p: Awaited<ReturnType<typeof pfl>>) => p.capital + p.totalLockedMm + p.legs.reduce((a, l) => a + l.posPnl, 0n);
  const legQty = (p: Awaited<ReturnType<typeof pfl>>) => { const l = p.legs.find((x) => x.rawBasis > 0n); return l ? (l.side === 1 ? 1 : -1) * Number(l.rawBasis) : 0; };
  const inv0 = legQty(await pfl(LPP));
  console.log(`  AMM vault inventory at start: ${inv0} (${inv0 === 0 ? "FLAT" : "HOLDS INVENTORY"})`);
  const tr = async (buy: boolean, limit?: bigint, qty = 100n) => {
    const ixs = await tradeWithMatcherFresh(conn, P, { dex: DEX, takerPortfolio: TP, taker: taker.publicKey, lpPortfolio: LPP, matcherProgram: M, matcherCtx: CTX,
      legs: [{ market: MKT1, mode: TRADE_MODE.NETTED, takerIsLong: buy, maxQty: qty, limitPrice: limit }] });
    return { ixs, n: ixs.length };
  };
  const mark = async () => (await mkt(MKT1)).markPrice;
  const rej = await sim((await tr(true, (await mark()) - 1_000_000n)).ixs);
  ok(rej.code === 130, `buy below the ask rejected by the slippage guard — ${rej.name}`);
  const lp0 = lpValue(await pfl(LPP));
  let feeSum = 0n; const rew0 = (await mkt(MKT1)).rewardAccrued;
  for (const [name, firstBuy] of [["LONG round trip", true], ["SHORT round trip", false]] as const) {
    for (const buy of [firstBuy, !firstBuy]) {
      const mkA = await mkt(MKT1); const px = mkA.markPrice;
      const limit = buy ? px + px / 50n : px - px / 50n;
      const t = await tr(buy, limit);
      const before = legQty(await pfl(TP)); const vBefore = legQty(await pfl(LPP));
      const sig = await send(t.ixs, [taker]);
      const after = legQty(await pfl(TP));
      const mkB = await mkt(MKT1);
      feeSum += mkB.rewardAccrued - mkA.rewardAccrued;
      ok(after - before === (buy ? 100 : -100), `${name}: taker ${buy ? "bought" : "sold"} 0.0001 vs the vault (taker ${before} -> ${after}, vault ${legQty(await pfl(LPP))}) [${t.n} ixs, ${await cuOf(sig)} CU]`);
      // the trade fee is charged on the OPENING side(s) only: 2 bps of notional per opening side, 100% to the reward accrual
      const vAfter = legQty(await pfl(LPP));
      const opens = (Math.abs(after) > Math.abs(before) ? 1 : 0) + (Math.abs(vAfter) > Math.abs(vBefore) ? 1 : 0);
      const perSide = (100n * mkA.markPrice / POS_SCALE) * 2n / 10_000n;
      const got = mkB.rewardAccrued - mkA.rewardAccrued;
      ok(mkB.insurance === mkA.insurance && got >= BigInt(opens) * perSide && got <= BigInt(opens) * (perSide + 2n), `  fee -> reward accrual +$${U(got)} = ${opens} opening side(s) x 2 bps (rewardBps 10000), insurance unchanged $${U(mkB.insurance)}`);
    }
    await conservation(`after ${name}`);
  }
  ok(legQty(await pfl(LPP)) === inv0, `vault inventory back to ${inv0}`);
  const lp1 = lpValue(await pfl(LPP));
  ok(lp1 >= lp0, `the vault did not lose principal over 2 round trips: $${U(lp0)} -> $${U(lp1)}`);
  ok((await mkt(MKT1)).rewardAccrued - rew0 === feeSum && feeSum > 0n, `reward accrual over the 4 fills: +$${U(feeSum)}`);
  const tpf = await pfl(TP);
  ok(openLegs(tpf).length === 0, "taker is flat");
  const bal0 = (await acct(FTOK)).readBigUInt64LE(64);
  await send([...await (await import("../src/lean/index.js")).realizeFlatLegs(conn, TP, opts)], []).catch(() => undefined);
  const cap = (await pfl(TP)).capital;
  await send([withdrawCollateral(P, V, { portfolio: TP, owner: taker.publicKey, destToken: FTOK, amount: cap })], [taker]);
  ok((await acct(FTOK)).readBigUInt64LE(64) - bal0 === cap, `taker withdrew everything: $${U(cap)} of $5 (cost = spread + fees)`);
  const tpf2 = await pfl(TP);
  if (tpf2.legCount === 0) { await send([closeAccount(P, { account: TP, authority: taker.publicKey, destination: O })], [taker]); ok((await conn.getAccountInfo(TP)) === null, "taker portfolio closed (CloseAccount)"); }
  else note(`taker portfolio left open: legCount ${tpf2.legCount} (flat leg with unrealized posPnl)`);
  await conservation("after taker withdraw/close");

  // ---- prize-2 style: deposit + withdraw on a FLAT pre-existing portfolio, deposit on the open userLong
  await send([depositCollateral(P, V, { portfolio: pflV, depositor: O, sourceToken: FTOK, amount: POS_SCALE })]);
  await send([withdrawCollateral(P, V, { portfolio: pflV, owner: O, destToken: FTOK, amount: POS_SCALE })]);
  ok((await pfl(pflV)).capital === 23n * POS_SCALE, "flat prize-2 portfolio: deposit $1 + withdraw $1 round trip, still $23");
  // ---- insurance: share-minting deposit into a NEW receipt (withdrawn at the end of the unwind, needs zero OI)
  const mkI = await mkt(MKT1);
  const rc = await newAcc(INS_RECEIPT_SIZE, P);
  const insSim = await sim([depositInsurance(P, V, { market: MKT1, receipt: rc, lp: O, sourceToken: FTOK, amount: 2n * POS_SCALE })]);
  if (insSim.ok) {
    await send([depositInsurance(P, V, { market: MKT1, receipt: rc, lp: O, sourceToken: FTOK, amount: 2n * POS_SCALE })]);
    const mkJ = await mkt(MKT1); const sh = parseInsReceipt(await acct(rc)).shares;
    ok(mkJ.insurance === mkI.insurance + 2n * POS_SCALE && sh > 0n, `insurance deposit $2 into a new receipt: insurance $${U(mkI.insurance)} -> $${U(mkJ.insurance)}, shares ${sh} (insFronted ${mkI.insFronted})`);
  } else {
    ok(insSim.code === 119 && mkI.insFronted > 0n, `insurance share-minting deposit rejected ${insSim.name} while insFronted=${mkI.insFronted} > 0 (NEW 8774e86 rule)`);
  }
  await conservation("after insurance deposit");

  // ---- reward keeper dry run + prize monitor (the real scripts, pointed at devnet)
  const rb = runScript("reward keeper (dry)", "scripts/_lean-r3-reward-bid.ts", [], { SOL_PRICE_USD: "150" });
  ok(rb.status === 0 && !/ERR/.test(rb.out), "reward keeper dry run read the state without error");
  const mon = runScript("prize monitor", "scripts/_lean-oi-monitor.ts", [], { LEAN_POLL_MS: "4000" }, 14_000);
  ok(/\[baseline\]/.test(mon.out) && !/ALERT/.test(mon.out), "prize monitor printed a baseline and no ALERT");
  const s1 = await conservation(`live[${TAG}] end`);
  console.log(`  insurance $${U(ins0)} -> $${U(s1.markets.get(MKT1.toBase58())!.insurance)}; prize-2 $${U((await pfl(pflV)).capital)}; prize-3 value $${U((await pfl(pflU)).capital + (await pfl(pflU)).totalLockedMm)}`);
}

async function main() {
  await guard();
  console.log(`=== upgrade-proof ${MODE} [${TAG}] on ${P.toBase58()} ===`);
  if (MODE === "probe") await probe(); else if (MODE === "live") await live(); else throw new Error("mode: probe | live");
  console.log(`\n${MODE.toUpperCase()} [${TAG}]: ${pass} ok, ${fails.length} failed${notes.length ? `, ${notes.length} notes` : ""}`);
  if (fails.length) { console.log("FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", mask(String((e as Error).stack ?? e)).slice(0, 1200)); process.exit(1); });
