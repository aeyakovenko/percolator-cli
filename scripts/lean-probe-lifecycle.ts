/**
 * Devnet probe of the CURRENTLY DEPLOYED build (GD43… = e292ad5): funding stress +
 * full wind-down/resolve lifecycle + adversarial rejections, checking V==SPL after
 * every step. Surfaces that lean-attack.ts doesn't cover.
 *
 *   SOLANA_RPC_URL=<devnet> pnpm tsx scripts/lean-probe-lifecycle.ts
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE,
  assertDevnet, leanErrorName,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, depositInsurance,
  withdrawInsurance, trade, liquidate, refreshLeg, startWindDown, forceClosePair, resolveMarket,
  claimResolved, tombstoneMarket, closeAccount, burnMarketAdmin,
  parseDex, parseMarket, parsePortfolio, snapshotDex, checkDexInvariants, withLegRefresh,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = LEAN_DEVNET.percolator;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function sendOk(ixs: TransactionInstruction[], signers: Keypair[] = [], refresh = false) {
  const list = refresh ? (await withLegRefresh(conn, ixs)).instructions : ixs;
  return sendAndConfirmTransaction(conn, new Transaction().add(...list), [funder, ...signers], { commitment: "confirmed" });
}
async function tryErr(ixs: TransactionInstruction[], signers: Keypair[]): Promise<number | string | null> {
  const tx = new Transaction().add(...ixs); tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(funder, ...signers);
  const r = (await conn.simulateTransaction(tx)).value; if (!r.err) return null;
  const ie = (r.err as any).InstructionError; return ie && typeof ie[1] === "object" && "Custom" in ie[1] ? ie[1].Custom : JSON.stringify(r.err);
}
async function reject(label: string, dex: PublicKey, ixs: TransactionInstruction[], signers: Keypair[], code?: number) {
  const r = await tryErr(ixs, signers);
  if (r === null) { fail.push(`SECURITY: "${label}" SUCCEEDED`); console.log(`  ✗✗ ${label} SUCCEEDED`); return; }
  ok(code === undefined || r === code, `reject ${label}: ${typeof r === "number" ? leanErrorName(r) : r}${code !== undefined && r !== code ? ` (wanted ${leanErrorName(code)})` : ""}`);
  ok((await inv(dex)).ok, `  …conservation after reject "${label}"`);
}
async function inv(dex: PublicKey) {
  const s = await snapshotDex(conn, P, dex);
  return checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map(m => m.data), s.portfolios.map(p => p.data));
}
async function waitSlots(n: number) { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) < s + n) await sleep(400); }

async function main() {
  await assertDevnet(conn);
  console.log(`lean-probe-lifecycle — ${P.toBase58()}`);
  const sol0 = await conn.getBalance(funder.publicKey);
  const newAcc = async (owner: PublicKey, size: number) => {
    const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(size);
    await sendOk([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
    return kp.publicKey;
  };
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);

  const dex = await newAcc(P, DEX_SIZE);
  await sendOk([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })], []);
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const V: VaultAccounts = { dex, mint, vault: d.vault };

  // --- gap confirmations (cheap, simulation)
  console.log("== confirm claimed gaps ==");
  const warmupMkt = await newAcc(P, MARKET_SIZE);
  const base: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 5000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 400n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  await reject("CreateMarket warmupSlots>0 (anti-flash gone)", dex, [createMarket(P, { dex, market: warmupMkt, mint, oracleAuth: funder.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: { ...base, warmupSlots: 10n } })], [], 103);

  const oracle = Keypair.generate();
  const mkt = await newAcc(P, MARKET_SIZE);
  await sendOk([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: base })], []);
  const ins = await newAcc(P, INS_RECEIPT_SIZE);
  await sendOk([depositInsurance(P, V, { market: mkt, receipt: ins, lp: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })], []);
  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await sendOk([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await sendOk([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await sendOk([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 60n * POS_SCALE })], []);
  await sendOk([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE })], []);
  await sendOk([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 5n * POS_SCALE })], [oL, oS], true);
  ok((await inv(dex)).ok, "conservation after open 5-unit L/S");
  // oracle gap: jump > maxMove rejected
  await waitSlots(1);
  await reject("oracle jump > maxMove (no restart)", dex, [updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 150n * POS_SCALE })], [oracle], 104);
  // insurance withdraw while OI>0 rejected
  await reject("withdrawInsurance while OI>0", dex, [withdrawInsurance(P, V, { market: mkt, receipt: ins, lp: funder.publicKey, destToken: fTok, burnShares: 1n })], [], 118);
  // can't change hands: single-sided close is impossible (close needs both L long & S short reducing) — try L-long vs a fresh flat buyer as "short closer"
  const oX = Keypair.generate(); const pX = await newAcc(P, PORTFOLIO_SIZE);
  await sendOk([initPortfolio(P, { dex, portfolio: pX, owner: oX.publicKey })], [oX]);
  await sendOk([depositCollateral(P, V, { portfolio: pX, depositor: funder.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE })], []);
  await reject("'sell long to new buyer' via close (no transfer)", dex, [trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pX, shortOwner: oX.publicKey, mode: TRADE_MODE.CLOSE, qty: POS_SCALE })], [oL, oX], 121);

  // --- FUNDING STRESS: push max funding against the long for many slots; conservation must hold,
  //     loser must become liquidatable, insurance draw bounded.
  console.log("== funding stress (max funding vs long) ==");
  let liquidated = false;
  for (let i = 0; i < 18 && !liquidated; i++) {
    await waitSlots(1);
    // fundingSign 0 = longs pay; push the max the clamp allows alongside no price move
    const m = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
    const maxFund = (m.markPrice * m.maxMoveBps) / 10_000n; // diff(0)+fund <= maxMove*mark
    try { await sendOk([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: m.markPrice, fundingSign: 0, fundingE6: maxFund })], [oracle]); }
    catch (e) { console.log(`   funding push ${i} rejected: ${String(e).slice(0, 80)}`); }
    const r = await inv(dex);
    ok(r.ok, `funding round ${i} conservation${r.ok ? "" : " — " + r.problems.join("; ")}`);
    if (!r.ok) break;
    // keep the long's leg settled so its loss realizes, then see if it's liquidatable
    try { await sendOk([refreshLeg(P, { dex, market: mkt, portfolio: pL })], []); } catch { /* */ }
    const liqRes = await tryErr([liquidate(P, V, { market: mkt, portfolio: pL, liquidatorToken: fTok })], []);
    if (liqRes === null) {
      await sendOk([liquidate(P, V, { market: mkt, portfolio: pL, liquidatorToken: fTok })], []);
      liquidated = true;
      ok((await inv(dex)).ok, "conservation after funding-driven liquidation");
      console.log(`   long liquidated at funding round ${i}`);
    }
  }
  ok(liquidated, "long eventually liquidated by sustained max funding (not stuck solvent-but-insolvent)");

  // --- WIND-DOWN / RESOLVE lifecycle + adversarial rejections
  console.log("== wind-down / resolve lifecycle ==");
  // after liquidation the long leg is gone; close remaining short with a fresh counterparty? Instead drive wind-down.
  await sendOk([burnMarketAdmin(P, { market: mkt, admin: funder.publicKey })], []);
  await reject("startWindDown while oracle fresh (admin burned)", dex, [startWindDown(P, { market: mkt, caller: funder.publicKey })], [], 105);
  // let the oracle go stale (maxStaleness 5000 is long; instead this market can't easily go stale in test —
  // so verify the permissionless-stale PATH guard exists, then exercise the happy path on a 2nd market)
  const mkt2 = await newAcc(P, MARKET_SIZE);
  await sendOk([createMarket(P, { dex, market: mkt2, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: { ...base, maxStaleness: 3n } })], []);
  const a2 = Keypair.generate(), b2 = Keypair.generate();
  const pA2 = await newAcc(P, PORTFOLIO_SIZE), pB2 = await newAcc(P, PORTFOLIO_SIZE);
  await sendOk([initPortfolio(P, { dex, portfolio: pA2, owner: a2.publicKey })], [a2]);
  await sendOk([initPortfolio(P, { dex, portfolio: pB2, owner: b2.publicKey })], [b2]);
  await sendOk([depositCollateral(P, V, { portfolio: pA2, depositor: funder.publicKey, sourceToken: fTok, amount: 200n * POS_SCALE })], []);
  await sendOk([depositCollateral(P, V, { portfolio: pB2, depositor: funder.publicKey, sourceToken: fTok, amount: 200n * POS_SCALE })], []);
  await sendOk([trade(P, { dex, market: mkt2, longPortfolio: pA2, longOwner: a2.publicKey, shortPortfolio: pB2, shortOwner: b2.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE })], [a2, b2], true);
  // burn admin, let oracle go stale (maxStaleness 3), permissionless wind-down
  await sendOk([burnMarketAdmin(P, { market: mkt2, admin: funder.publicKey })], []);
  await waitSlots(5);
  await sendOk([startWindDown(P, { market: mkt2, caller: funder.publicKey })], []);
  ok(parseMarket(Buffer.from((await conn.getAccountInfo(mkt2))!.data)).status === 1, "mkt2 -> WINDDOWN (permissionless, stale)");
  await reject("forceClosePair during exitWindow", dex, [forceClosePair(P, { dex, market: mkt2, longPortfolio: pA2, shortPortfolio: pB2 })], [], 117);
  await reject("resolve before OI zero", dex, [resolveMarket(P, { market: mkt2 })], [], 118);
  await waitSlots(11);
  await sendOk([forceClosePair(P, { dex, market: mkt2, longPortfolio: pA2, shortPortfolio: pB2 })], []);
  ok(parseMarket(Buffer.from((await conn.getAccountInfo(mkt2))!.data)).oiLong === 0n, "forceClosePair netted OI to 0");
  await sendOk([resolveMarket(P, { market: mkt2 })], []);
  await reject("tombstone before fully drained", dex, [tombstoneMarket(P, { market: mkt2 })], [], 119);
  for (const [who, pf] of [["A2", pA2], ["B2", pB2]] as const) {
    const leg = parsePortfolio(Buffer.from((await conn.getAccountInfo(pf))!.data)).legs.find(l => l.market.equals(mkt2));
    if (leg) await sendOk([claimResolved(P, { dex, market: mkt2, portfolio: pf })], []);
    else console.log(`   ${who} no mkt2 leg to claim`);
  }
  await sendOk([tombstoneMarket(P, { market: mkt2 })], []);
  ok(parseMarket(Buffer.from((await conn.getAccountInfo(mkt2))!.data)).status === 3, "mkt2 -> TOMBSTONED");
  await sendOk([closeAccount(P, { account: mkt2, authority: funder.publicKey, destination: funder.publicKey })], []);
  ok((await conn.getAccountInfo(mkt2)) === null, "tombstoned mkt2 closed, rent reclaimed");
  ok((await inv(dex)).ok, "final conservation");

  const spent = (sol0 - await conn.getBalance(funder.publicKey)) / 1e9;
  const sec = fail.filter(f => f.startsWith("SECURITY")).length;
  console.log(`\n${pass} passed, ${fail.length} failed (${sec} security) — spent ${spent.toFixed(4)} SOL — dex ${dex.toBase58()}`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("CLEAN"); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
