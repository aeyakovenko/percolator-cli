/** Round-4 MAINNET: add a passive AMM vault (PropAMM) on the live BTC/USD market with MINIMUM funds, then smoke it.
 *  LP portfolio (owner = funder) funded with LP_FUND; ctx created + initialised in ONE tx; bound with SetPortfolioMatcher.
 *  Smoke: a FRESH taker keypair (single signer, the LP never signs) trades NETTED long/short round trips against the vault;
 *  checks fill sizes, LP inventory, LP P&L, the slippage guard, same-slot conservation and that the prizes are untouched.
 *  Re-runnable: if lean-mainnet-r4.json already has `ammVault`, setup is skipped and only the smoke runs.  --live to send. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_MAINNET, PORTFOLIO_SIZE, PROP_CTX_SIZE, POS_SCALE, TRADE_MODE, initPortfolio, depositCollateral, withdrawCollateral,
  propAmmInit, setPortfolioMatcher, tradeWithMatcherFresh, deriveDexVault, parseDex, parseMarket, parsePortfolio, parsePropAmmCtx,
  type VaultAccounts,
} from "../src/lean/index.js";

const LIVE = process.argv.includes("--live");
const LP_FUND = 3_000_000n, TAKER_FUND = 1_000_000n;           // $3.00 / $1.00 (taker funds are withdrawn back)
const HALF_SPREAD_BPS = 20n, IMPACT_BPS = 5n, MAX_FILL = 200n; // 0.0002 BTC per fill (~$12)
const TRADE_QTY = 100n;                                        // 0.0001 BTC per smoke fill
const MANI_PATH = "lean-mainnet-r4.json";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync(MANI_PATH, "utf8"));
const P = new PublicKey(m.percolator), M = new PublicKey(m.matcher), DEX = new PublicKey(m.dex), MKT = new PublicKey(m.market), USDC = new PublicKey(m.usdc);
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const V: VaultAccounts = { dex: DEX, mint: USDC, vault: deriveDexVault(P, DEX)[0] };
const U = (n: bigint) => (Number(n) / 1e6).toFixed(4);
let ok = 0; const fails: string[] = [];
const check = (c: boolean, s: string) => { if (c) { ok++; console.log("  OK   " + s); } else { fails.push(s); console.log("  FAIL " + s); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  for (let i = 0; ; i++) {
    try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...signers], { commitment: "confirmed" }); }
    catch (e) { const t = String((e as Error).message ?? e); if (i < 5 && /429|Too Many|rate|block height|timed out|not found/i.test(t)) { await sleep(2000 * (i + 1)); continue; } throw e; }
  }
}
const acct = async (k: PublicKey) => Buffer.from((await conn.getAccountInfo(k, "confirmed"))!.data);
async function newAcc(space: number, owner: PublicKey) {
  const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(space);
  return { kp, ix: SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space, programId: owner }) };
}
async function snapshot(tag: string) {
  const r = await conn.getMultipleAccountsInfoAndContext([DEX, V.vault, MKT, new PublicKey(m.prizes.vaultPortfolio), new PublicKey(m.prizes.userLong)], "confirmed");
  const d = parseDex(Buffer.from(r.value[0]!.data)), spl = Buffer.from(r.value[1]!.data).readBigUInt64LE(64), mk = parseMarket(Buffer.from(r.value[2]!.data));
  const sum = d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards;
  const vpf = parsePortfolio(Buffer.from(r.value[3]!.data)), ul = parsePortfolio(Buffer.from(r.value[4]!.data));
  console.log(`[${tag} @slot ${r.context.slot}] V=$${U(d.vaultBalance)} SPL=$${U(spl)} | insurance $${U(mk.insurance)} prize2 $${U(vpf.capital + vpf.totalLockedMm)} prize3 $${U(ul.capital + ul.totalLockedMm)} | mark $${U(mk.markPrice)}`);
  check(d.vaultBalance === spl && spl === sum, `${tag}: conservation V==SPL==C+I+R+S+Rew (same slot)`);
  check(mk.insurance === 23_000_000n && vpf.capital === 23_000_000n, `${tag}: insurance + prize-2 untouched ($23/$23)`);
  return mk;
}
const lpValue = (p: ReturnType<typeof parsePortfolio>) => p.capital + p.totalLockedMm + p.legs.reduce((a, l) => a + l.posPnl, 0n);

async function main() {
  console.log(`${LIVE ? "LIVE" : "DRY"}: round-4 AMM vault on market ${MKT.toBase58().slice(0, 8)}… (LP $${U(LP_FUND)}, halfSpread ${HALF_SPREAD_BPS}bps, maxFill ${Number(MAX_FILL) / 1e6} BTC)`);
  const fTok = await getAssociatedTokenAddress(USDC, funder.publicKey);
  const have = (await getAccount(conn, fTok)).amount;
  const need = LP_FUND + TAKER_FUND + 100_000n;
  console.log(`wallet USDC $${U(have)} (need >= $${U(need)})`);
  if (have < need) throw new Error("not enough USDC");
  const mk0 = await snapshot("start");
  const slot = await conn.getSlot("confirmed");
  console.log(`oracle age ${slot - Number(mk0.lastOracleSlot)} / maxStaleness ${mk0.maxStaleness} slots`);
  if (slot - Number(mk0.lastOracleSlot) > Number(mk0.maxStaleness) * 0.8) throw new Error("oracle too old to trade; wait for the keeper");
  if (!LIVE) { console.log("DRY RUN ok — re-run with --live to send transactions."); return; }

  // ---------------------------------------------------------------- setup (once)
  if (!m.ammVault) {
    const lp = await newAcc(PORTFOLIO_SIZE, P);
    await send([lp.ix], [lp.kp]);
    await send([initPortfolio(P, { dex: DEX, portfolio: lp.kp.publicKey, owner: funder.publicKey })]);
    await send([depositCollateral(P, V, { portfolio: lp.kp.publicKey, depositor: funder.publicKey, sourceToken: fTok, amount: LP_FUND })]);
    const ctx = await newAcc(PROP_CTX_SIZE, M);
    await send([ctx.ix, propAmmInit(M, { ctx: ctx.kp.publicKey, owner: funder.publicKey, allowedMarketIds: [mk0.marketId], halfSpreadBps: HALF_SPREAD_BPS, impactBps: IMPACT_BPS, maxFillQty: MAX_FILL })], [ctx.kp]);
    await send([setPortfolioMatcher(P, { portfolio: lp.kp.publicKey, owner: funder.publicKey, matcherCtx: ctx.kp.publicKey })]);
    m.ammVault = { kind: "PropAMM", matcherProgram: M.toBase58(), ctx: ctx.kp.publicKey.toBase58(), lpPortfolio: lp.kp.publicKey.toBase58(), ownerKey: "funder/id.json",
      halfSpreadBps: Number(HALF_SPREAD_BPS), impactBps: Number(IMPACT_BPS), maxFillQty: MAX_FILL.toString(), lpCapitalUsd: Number(LP_FUND) / 1e6, allowedMarketIds: [mk0.marketId.toString()], createdAt: new Date().toISOString() };
    fs.writeFileSync(MANI_PATH, JSON.stringify(m, null, 2) + "\n");   // record BEFORE any test trade
    console.log(`vault created: ctx ${m.ammVault.ctx}  LP portfolio ${m.ammVault.lpPortfolio}`);
  } else console.log(`vault already recorded: ctx ${m.ammVault.ctx}`);
  const CTX = new PublicKey(m.ammVault.ctx), LPP = new PublicKey(m.ammVault.lpPortfolio);
  const ctxP = parsePropAmmCtx(await acct(CTX));
  check(ctxP.halfSpreadBps === HALF_SPREAD_BPS && ctxP.maxFillQty === MAX_FILL && ctxP.allowedMarkets.includes(mk0.marketId) && !ctxP.paused, "ctx params + allowlist as configured, not paused");
  check(parsePortfolio(await acct(LPP)).matcherCtx.equals(CTX), "LP portfolio is bound to the ctx");
  check(ctxP.owner.equals(funder.publicKey), "ctx owner = funder (owner-gated params)");

  // ---------------------------------------------------------------- smoke: a fresh single-signer taker
  const taker = Keypair.generate();
  const tpf = await newAcc(PORTFOLIO_SIZE, P);
  await send([tpf.ix], [tpf.kp]);
  await send([initPortfolio(P, { dex: DEX, portfolio: tpf.kp.publicKey, owner: taker.publicKey })], [taker]);
  await send([depositCollateral(P, V, { portfolio: tpf.kp.publicKey, depositor: funder.publicKey, sourceToken: fTok, amount: TAKER_FUND })]);
  const TP = tpf.kp.publicKey;
  const lp0 = lpValue(parsePortfolio(await acct(LPP)));
  const trade = async (buy: boolean, limit: bigint | undefined, qty = TRADE_QTY) => {
    const ixs = await tradeWithMatcherFresh(conn, P, { dex: DEX, takerPortfolio: TP, taker: taker.publicKey, lpPortfolio: LPP, matcherProgram: M, matcherCtx: CTX,
      legs: [{ market: MKT, mode: TRADE_MODE.NETTED, takerIsLong: buy, maxQty: qty, limitPrice: limit }] });
    return send(ixs, [taker]);   // ONLY the taker signs (the funder is just the fee payer)
  };
  const mark = async () => parseMarket(await acct(MKT)).markPrice;
  const legQty = (p: ReturnType<typeof parsePortfolio>) => { const l = p.legs.find(x => x.rawBasis > 0n); return l ? (l.side === 1 ? 1 : -1) * Number(l.rawBasis) : 0; };

  // slippage guard: a buy with a limit BELOW the vault's ask must be rejected (130) and cost nothing
  let rej = "no error";
  try { await trade(true, (await mark()) - 1_000_000n); } catch (e) { rej = String((e as Error).message ?? e); }
  check(/0x82|130/.test(rej), `buy below the ask rejected by the slippage guard (130) — ${rej.slice(0, 60).replace(/\s+/g, " ")}`);

  for (const [name, firstBuy] of [["LONG round trip", true], ["SHORT round trip", false]] as const) {
    const mk = await mark(); const lim = (b: boolean) => b ? mk + mk / 50n : mk - mk / 50n;     // +/-2% guard
    await trade(firstBuy, lim(firstBuy));
    const t1 = parsePortfolio(await acct(TP)), l1 = parsePortfolio(await acct(LPP));
    check(legQty(t1) === (firstBuy ? 1 : -1) * Number(TRADE_QTY), `${name}: taker opened ${firstBuy ? "long" : "short"} ${Number(TRADE_QTY) / 1e6} BTC against the vault`);
    check(legQty(l1) === (firstBuy ? -1 : 1) * Number(TRADE_QTY), `${name}: the vault took the other side (${firstBuy ? "short" : "long"})`);
    await trade(!firstBuy, lim(!firstBuy));
    const t2 = parsePortfolio(await acct(TP)), l2 = parsePortfolio(await acct(LPP));
    check(legQty(t2) === 0 && legQty(l2) === 0, `${name}: closed — taker and vault both flat`);
  }
  const lp1 = lpValue(parsePortfolio(await acct(LPP)));
  console.log(`LP value $${U(lp0)} -> $${U(lp1)}  (${lp1 >= lp0 ? "+" : ""}${U(lp1 - lp0)} over 2 round trips)`);
  check(lp1 >= lp0, "the vault did not lose principal at a (nearly) flat mark");

  // withdraw the taker's funds back
  const tp = parsePortfolio(await acct(TP));
  if (tp.capital > 0n) await send([withdrawCollateral(P, V, { portfolio: TP, owner: taker.publicKey, destToken: fTok, amount: tp.capital })], [taker]);
  console.log(`taker funds returned: $${U(tp.capital)} of $${U(TAKER_FUND)} (cost = spread + fees)`);
  await snapshot("end");
  console.log(`\nAMM SMOKE: ${ok} ok, ${fails.length} failed`);
  if (fails.length) process.exit(1);
}
main().then(() => process.exit(0)).catch(e => { console.error("ERR", String(e).replace(/api-key=[^ "&]*/g, "api-key=***").slice(0, 600)); process.exit(1); });
