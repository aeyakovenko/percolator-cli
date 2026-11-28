/**
 * ROUND-5 REHEARSAL — ATTACK CATALOGUE against the three prize surfaces (insurance / AMM vault / user
 * position) of a round-5 market (887ba02 PropAMM vault). Fresh attacker keypairs with small funded
 * accounts. Each attack prints BLOCKED (with the error code) or EXTRACTED (with exact amounts: attacker
 * net USDC after withdrawing everything vs what it put in). All AMM-specific calls go through the vault
 * adapter (_lean-round5-vault.ts) so OracleAmmMatcher can be swapped in later.
 *
 *   LEAN_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-round5-attacks.ts [--only ins|amm|user|latency]
 * DEVNET ONLY. Re-runnable (fresh keys each run).
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE, IX, MIN_FIRST_INS_DEPOSIT,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, withdrawCollateral, depositInsurance, refreshLeg, trade, liquidate, startWindDown, closeAccount,
  packFundingCfg, assertDevnet, deriveDexVault, parseMarket, parsePortfolio, leanErrorName, snapshotDex, checkDexInvariants,
  maskSecrets,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";
import { propAmmVault, type VaultAdapter, type VaultLeg } from "./_lean-round5-vault.js";

const RPC = process.env.LEAN_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const M = new PublicKey(process.env.LEAN_MATCHER ?? LEAN_DEVNET.matcher.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] : null; })();
const vault: VaultAdapter = propAmmVault(M);

const say = (s: string) => console.log(maskSecrets(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
// portfolio equity = capital + marked leg PnL (realized/unrealized both counted, incl. flat legs)
const equityOf = async (p: PublicKey) => { const pf = await pflOf(p); return pf.capital + pf.totalLockedMm + pf.legs.reduce((a, l) => a + l.posPnl, 0n); };
const tok = async (t: PublicKey) => (await getAccount(conn, t, "confirmed")).amount;
async function waitSlots(n: number) { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) < s + n) await sleep(300); }

/** simulate ixs; return the custom error code, a string tag, or null if it would SUCCEED. */
async function trySim(ixs: TransactionInstruction[], signers: Keypair[]): Promise<number | string | null> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = funder.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  try { tx.sign(funder, ...signers); } catch (e) { return `signer:${String(e).slice(0, 40)}`; }
  const r = (await conn.simulateTransaction(tx)).value;
  if (!r.err) return null;
  const ie = (r.err as any)?.InstructionError;
  if (ie && typeof ie[1] === "object" && "Custom" in ie[1]) return ie[1].Custom as number;
  return JSON.stringify(r.err).slice(0, 60);
}

// ---------------------------------------------------------------- results table
const rows: { surface: string; attack: string; verdict: "BLOCKED" | "EXTRACTED" | "INFO"; detail: string }[] = [];
const rec = (surface: string, attack: string, verdict: "BLOCKED" | "EXTRACTED" | "INFO", detail: string) => {
  rows.push({ surface, attack, verdict, detail }); say(`  [${verdict}] ${surface} / ${attack}: ${detail}`);
};
const blocked = (surface: string, attack: string, code: number | string | null, expected?: number) => {
  if (code === null) { rec(surface, attack, "EXTRACTED", `the attack SUCCEEDED in simulation (expected a rejection${expected ? " " + leanErrorName(expected) : ""})`); return false; }
  const name = typeof code === "number" ? leanErrorName(code) : code;
  rec(surface, attack, "BLOCKED", `rejected with ${name}${typeof code === "number" ? ` (${code})` : ""}`); return true;
};

// ---------------------------------------------------------------- a round-5 product (adequately capitalized vault for AMM tests)
interface Product { dex: PublicKey; V: VaultAccounts; mint: PublicKey; fTok: PublicKey; feeVault: PublicKey; mkt: PublicKey; marketId: bigint; oracle: Keypair; ctx: PublicKey; lpPfl: PublicKey; lpOwner: Keypair; price: number; maxStale: bigint; half: bigint; impact: bigint; maxFill: bigint; }
const FUND = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
function r5params(initPrice: bigint, maxStale: bigint): MarketParams {
  return { initPrice, exitWindow: 10n, maxStaleness: maxStale, fundingCfg: FUND, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
}
async function standUp(o: { price: number; maxStale?: bigint; half?: bigint; impact?: bigint; maxFill?: bigint; vaultCap?: bigint; insurance?: bigint }): Promise<Product> {
  const maxStale = o.maxStale ?? 300n, half = o.half ?? 20n, impact = o.impact ?? 3000n, maxFill = o.maxFill ?? 2_000n;
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 1_000_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: r5params(e6(o.price), maxStale) })]);
  const marketId = (await mktOf(mkt)).marketId;
  const insR = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: insR, lp: funder.publicKey, sourceToken: fTok, amount: o.insurance ?? 23n * POS_SCALE })]);
  const lpOwner = Keypair.generate();
  const ctxKp = Keypair.generate(); const ctx = ctxKp.publicKey;
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(vault.ctxSize));
  await send(vault.initCtxIxs({ ctx, owner: lpOwner.publicKey, payer: funder.publicKey, rentLamports: rent, params: { halfSpreadBps: half, impactBps: impact, maxFillQty: maxFill }, allowedMarketIds: [marketId] }), [ctxKp, lpOwner]);
  const lpPfl = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: lpPfl, owner: lpOwner.publicKey })], [lpOwner]);
  await send([vault.bindIx({ percolator: P, portfolio: lpPfl, owner: lpOwner.publicKey, ctx })], [lpOwner]);
  await send([depositCollateral(P, V, { portfolio: lpPfl, depositor: funder.publicKey, sourceToken: fTok, amount: o.vaultCap ?? 2_000n * POS_SCALE })]);
  return { dex, V, mint, fTok, feeVault, mkt, marketId, oracle, ctx, lpPfl, lpOwner, price: o.price, maxStale, half, impact, maxFill };
}
/** fresh funded portfolio with its own token account (a taker/attacker). */
async function mkActor(pr: Product, cap: bigint) {
  const o = Keypair.generate();
  const t = await createAccount(conn, funder, pr.mint, o.publicKey, Keypair.generate());
  const p = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex: pr.dex, portfolio: p, owner: o.publicKey })], [o]);
  await send([depositCollateral(P, pr.V, { portfolio: p, depositor: funder.publicKey, sourceToken: pr.fTok, amount: cap })]);
  return { o, p, t };
}
async function push(pr: Product, price: number) { await send([updateOracle(P, { market: pr.mkt, oracleAuth: pr.oracle.publicKey, price: e6(price) })], [pr.oracle]); }
/** move the mark toward target in ramp-free (<50% band) steps so the vault never enters its ramp cooldown. */
async function keeperTo(pr: Product, target: number) {
  for (let i = 0; i < 20; i++) {
    const m = await mktOf(pr.mkt);
    if (m.markPrice === e6(target)) return;
    await waitSlots(2);
    const old = Number(m.markPrice) / 1e6;
    const band = old * 0.01;                       // maxMoveBps 100 at dt>=2
    const step = Math.min(band * 0.49, Math.abs(target - old)); // < 50% band -> no ramp stamp
    const next = target > old ? old + step : old - step;
    await push(pr, Math.round(next * 100) / 100);
  }
}
async function conservationOk(pr: Product): Promise<boolean> {
  const s = await snapshotDex(conn, P, pr.dex);
  const rep = checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map((m) => m.data), s.portfolios.map((p) => p.data));
  return rep.ok;
}
async function fill(pr: Product, actor: { o: Keypair; p: PublicKey }, mode: number, takerIsLong: boolean, qty: bigint) {
  const m = await mktOf(pr.mkt);
  const isRamping = m.lastRampSlot > 0n && BigInt(await conn.getSlot("confirmed")) <= m.lastRampSlot + 152n;
  const leg: VaultLeg = { market: pr.mkt, marketId: pr.marketId, mode, takerIsLong, maxQty: qty, markPrice: m.markPrice, maxMoveBps: m.maxMoveBps, isRamping };
  const ixs = await vault.takerFill(conn, { percolator: P, dex: pr.dex, taker: actor.o.publicKey, takerPortfolio: actor.p, lpPortfolio: pr.lpPfl, ctx: pr.ctx, legs: [leg] });
  return send(ixs, [actor.o]);
}

// ================================================================= INSURANCE surface
async function insuranceSurface() {
  say("\n================ INSURANCE surface ================");
  // I1 — cross-margin + self-oracle drain of an HONEST market's insurance (round-2 class), round-5 params.
  // Price-agnostic isolation test: markets at $100 with the proven xmargin quantities (round-5 fee/funding params).
  {
    const pr = await standUp({ price: 100, maxStale: 9000n, insurance: 50n * POS_SCALE, vaultCap: 10n * POS_SCALE });
    const ins0 = (await mktOf(pr.mkt)).insurance;
    // attacker's OWN market with attacker as oracle auth
    const atkOracle = Keypair.generate();
    const atkMkt = await newAcc(P, MARKET_SIZE);
    await send([createMarket(P, { dex: pr.dex, market: atkMkt, mint: pr.mint, oracleAuth: atkOracle.publicKey, creator: funder.publicKey, creatorToken: pr.fTok, feeVault: pr.feeVault, params: r5params(e6(100), 9000n) })]);
    const atk = await mkActor(pr, 300n * POS_SCALE);
    const cpH = await mkActor(pr, 300n * POS_SCALE), cpA = await mkActor(pr, 300n * POS_SCALE);
    // attacker SHORT on honest market (vs cpH long) and LONG on attacker market (vs cpA short), sharing capital
    await send([trade(P, { dex: pr.dex, market: pr.mkt, longPortfolio: cpH.p, longOwner: cpH.o.publicKey, shortPortfolio: atk.p, shortOwner: atk.o.publicKey, mode: TRADE_MODE.OPEN, qty: 8n * POS_SCALE })], [cpH.o, atk.o]);
    await send([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: atk.p }), trade(P, { dex: pr.dex, market: atkMkt, longPortfolio: atk.p, longOwner: atk.o.publicKey, shortPortfolio: cpA.p, shortOwner: cpA.o.publicKey, mode: TRADE_MODE.OPEN, qty: 8n * POS_SCALE })], [atk.o, cpA.o]);
    // crash the attacker market to try to blow up the shared portfolio and draw the HONEST insurance
    let priceA = 100, drew = false;
    for (let i = 0; i < 30 && !drew; i++) {
      await waitSlots(2); priceA = priceA * 0.99;
      try { await send([updateOracle(P, { market: atkMkt, oracleAuth: atkOracle.publicKey, price: e6(priceA) })], [atkOracle]); } catch { break; }
      await send([refreshLeg(P, { dex: pr.dex, market: atkMkt, portfolio: atk.p })]).catch(() => {});
      for (const mk of [atkMkt, pr.mkt]) { const code = await trySim([liquidate(P, pr.V, { market: mk, portfolio: atk.p, liquidatorToken: pr.fTok })], []); if (code === null) await send([liquidate(P, pr.V, { market: mk, portfolio: atk.p, liquidatorToken: pr.fTok })]).catch(() => {}); }
      if ((await mktOf(pr.mkt)).insurance < ins0) drew = true;
    }
    const insF = (await mktOf(pr.mkt)).insurance;
    if (insF < ins0) rec("insurance", "cross-margin self-oracle drain (round-2 class)", "EXTRACTED", `honest insurance ${usd(ins0)} -> ${usd(insF)}`);
    else rec("insurance", "cross-margin self-oracle drain (round-2 class)", "BLOCKED", `honest insurance untouched (${usd(ins0)}), conservation ${await conservationOk(pr)} (isolation holds)`);
  }
  // I2 — account-reuse insurance-share inflation (round-1 class)
  {
    const pr = await standUp({ price: 60_000, insurance: 100n * POS_SCALE, vaultCap: 10n * POS_SCALE });
    const A = await newAcc(P, PORTFOLIO_SIZE);
    await send([initPortfolio(P, { dex: pr.dex, portfolio: A, owner: funder.publicKey })]);
    const rent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_SIZE);
    const reuse = [
      { account: A, authority: funder.publicKey, destination: new PublicKey("11111111111111111111111111111112") },
    ];
    // CloseAccount(A) then reuse as InsReceipt with a 1-atom deposit in one tx
    const code = await trySim([
      closeAccount(P, reuse[0]),
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: A, lamports: rent }),
      depositInsurance(P, pr.V, { market: pr.mkt, receipt: A, lp: funder.publicKey, sourceToken: pr.fTok, amount: 1n }),
    ], []);
    blocked("insurance", "account-reuse share inflation (round-1 class)", code);
  }
  // I3 — 1-atom par-mint first insurance deposit (anti-inflation floor)
  {
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
    const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
    await mintTo(conn, funder, mint, fTok, funder, 1000n * POS_SCALE);
    const dex = await newAcc(P, DEX_SIZE);
    await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
    const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
    const mkt = await newAcc(P, MARKET_SIZE);
    await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: Keypair.generate().publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: r5params(e6(60_000), 300n) })]);
    const r = await newAcc(P, INS_RECEIPT_SIZE);
    const code = await trySim([depositInsurance(P, V, { market: mkt, receipt: r, lp: funder.publicKey, sourceToken: fTok, amount: MIN_FIRST_INS_DEPOSIT - 1n })], []);
    blocked("insurance", `first insurance deposit < ${MIN_FIRST_INS_DEPOSIT} atoms (share-inflation floor)`, code, 103);
  }
}

// ================================================================= AMM VAULT surface
async function ammSurface() {
  say("\n================ AMM VAULT surface ================");
  const pr = await standUp({ price: 60_000, vaultCap: 2_000n * POS_SCALE });

  // A3 — availability DoS / substitution
  {
    const atk = await mkActor(pr, 40n * POS_SCALE);
    // attacker pause (not the ctx owner)
    const cPause = await trySim([vault.updateCtxIx({ ctx: pr.ctx, owner: atk.o.publicKey, params: { halfSpreadBps: pr.half, impactBps: pr.impact, maxFillQty: pr.maxFill, paused: true } })], [atk.o]);
    blocked("amm-vault", "attacker pauses the vault (not owner)", cPause, 111);
    // substitute the matcher PROGRAM (point at a non-matcher program id)
    const wrongProg = SystemProgram.programId;
    const legs = [{ market: pr.mkt, marketId: pr.marketId, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: 500n, markPrice: (await mktOf(pr.mkt)).markPrice, maxMoveBps: 100n }];
    try {
      const raw = vault.rawTakerFill({ percolator: P, dex: pr.dex, taker: atk.o.publicKey, takerPortfolio: atk.p, lpPortfolio: pr.lpPfl, ctx: pr.ctx, legs, matcherProgram: wrongProg });
      const c = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: pr.lpPfl }), raw], [atk.o]);
      blocked("amm-vault", "substitute the matcher program id", c, 131);
    } catch (e) { rec("amm-vault", "substitute the matcher program id", "BLOCKED", `builder refuses: ${String(e).slice(0, 60)}`); }
    // substitute a stranger's ctx the LP never bound
    const strangerCtxKp = Keypair.generate();
    const rent = BigInt(await conn.getMinimumBalanceForRentExemption(vault.ctxSize));
    await send(vault.initCtxIxs({ ctx: strangerCtxKp.publicKey, owner: atk.o.publicKey, payer: funder.publicKey, rentLamports: rent, params: { halfSpreadBps: 1n, impactBps: 0n, maxFillQty: pr.maxFill }, allowedMarketIds: [pr.marketId] }), [strangerCtxKp, atk.o]);
    const rawCtx = vault.rawTakerFill({ percolator: P, dex: pr.dex, taker: atk.o.publicKey, takerPortfolio: atk.p, lpPortfolio: pr.lpPfl, ctx: pr.ctx, legs, matcherCtx: strangerCtxKp.publicKey });
    const cCtx = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: pr.lpPfl }), rawCtx], [atk.o]);
    blocked("amm-vault", "substitute an unbound (attacker-owned) ctx", cCtx, 131);
  }

  // A1 — LATENCY ARBITRAGE table: for each (halfSpread, maxFill), jump the spot and arb the stale quote.
  say("\n  -- A1 latency-arbitrage table (LP loss per event) --");
  const latencyTable: { half: bigint; maxFill: string; dBps: number; lpLoss: string; atkProfit: string; lpLossE6: bigint; atkNetE6: bigint }[] = [];
  for (const half of [10n, 40n]) {
    await send([vault.updateCtxIx({ ctx: pr.ctx, owner: pr.lpOwner.publicKey, params: { halfSpreadBps: half, impactBps: pr.impact, maxFillQty: pr.maxFill, paused: false } })], [pr.lpOwner]);
    for (const dBps of [15, 60]) {
      // reset mark to a clean 60000
      await keeperTo(pr, 60_000);
      const atk = await mkActor(pr, 60n * POS_SCALE);
      const lp0 = await equityOf(pr.lpPfl);
      // attacker observes spot already jumped to M1 but the on-chain mark is still M0: BUY from the stale vault
      await fill(pr, atk, TRADE_MODE.NETTED, true, pr.maxFill);
      // keeper catches up: mark -> M1 in ramp-free steps
      const m1 = Math.round(60_000 * (1 + dBps / 1e4) * 100) / 100;
      await keeperTo(pr, m1);
      // attacker closes the long (SELLS) at the fresh quote, then we measure true economic value (equity)
      await fill(pr, atk, TRADE_MODE.NETTED, false, pr.maxFill);
      const lp1 = await equityOf(pr.lpPfl);
      const atkFinalCap = await equityOf(atk.p);
      const lpLoss = lp0 - lp1;
      const atkNet = atkFinalCap - 60n * POS_SCALE;
      latencyTable.push({ half, maxFill: (Number(pr.maxFill) / 1e6).toFixed(4), dBps, lpLoss: usd(lpLoss), atkProfit: usd(atkNet), lpLossE6: lpLoss, atkNetE6: atkNet });
      say(`     half=${half}bps maxFill=${(Number(pr.maxFill) / 1e6).toFixed(4)}BTC  +${dBps}bps jump -> LP capital Δ=${usd(lp1 - lp0)}, attacker net=${usd(atkFinalCap - 60n * POS_SCALE)}`);
    }
  }
  // restore half-spread
  await send([vault.updateCtxIx({ ctx: pr.ctx, owner: pr.lpOwner.publicKey, params: { halfSpreadBps: pr.half, impactBps: pr.impact, maxFillQty: pr.maxFill, paused: false } })], [pr.lpOwner]);
  const profitable = latencyTable.filter((r) => r.atkNetE6 > 0n && r.lpLossE6 > 0n);
  const worstLoss = latencyTable.reduce((a, r) => (r.lpLossE6 > a ? r.lpLossE6 : a), 0n);
  rec("amm-vault", "latency arbitrage (stale quote)", profitable.length ? "EXTRACTED" : "INFO",
    profitable.length ? `${profitable.length}/${latencyTable.length} (half,jump) combos profitable for the attacker; worst single-event LP loss ${usd(worstLoss)} (see table). Arb appears when jump > 2x effBps; a bigger half-spread blocks it.`
      : `no combo was profitable for the attacker (half-spread covered the jump); see table`);
  (globalThis as any).__latencyTable = latencyTable;

  // A5 — reduce-only fill at a stale mark (known staleness bypass): let the oracle go stale, then a CLOSE fill
  {
    await keeperTo(pr, 60_000);
    const atk = await mkActor(pr, 60n * POS_SCALE);
    await fill(pr, atk, TRADE_MODE.NETTED, true, pr.maxFill);       // open a long while fresh
    // let the oracle go stale (past maxStaleness) while REAL spot drops; mark stays at 60000
    say(`     letting oracle go stale (> ${pr.maxStale} slots) with mark frozen at $60000 ...`);
    await waitSlots(Number(pr.maxStale) + 6);
    const openCode = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: pr.lpPfl }), ...(await vault.takerFill(conn, { percolator: P, dex: pr.dex, taker: atk.o.publicKey, takerPortfolio: atk.p, lpPortfolio: pr.lpPfl, ctx: pr.ctx, legs: [{ market: pr.mkt, marketId: pr.marketId, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: pr.maxFill, markPrice: e6(60_000), maxMoveBps: 100n }] }))], [atk.o]).catch(() => "build-fail");
    const closeCode = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: pr.lpPfl }), ...(await vault.takerFill(conn, { percolator: P, dex: pr.dex, taker: atk.o.publicKey, takerPortfolio: atk.p, lpPortfolio: pr.lpPfl, ctx: pr.ctx, legs: [{ market: pr.mkt, marketId: pr.marketId, mode: TRADE_MODE.CLOSE, takerIsLong: true, maxQty: pr.maxFill, markPrice: e6(60_000), maxMoveBps: 100n }] }))], [atk.o]).catch(() => "build-fail");
    const detail = `OPEN while stale -> ${openCode === null ? "ALLOWED" : leanErrorName(openCode as number)}; reduce-only CLOSE while stale -> ${closeCode === null ? "ALLOWED (reduce-only ignores staleness)" : leanErrorName(closeCode as number)}`;
    rec("amm-vault", "reduce-only fill at a stale mark (staleness bypass)", closeCode === null ? "INFO" : "BLOCKED", detail);
    await push(pr, 60_000); // revive
  }

  // A4 — WIND-DOWN KILL: attacker starts wind-down permissionlessly once the oracle ages past maxStaleness
  {
    await keeperTo(pr, 60_000);
    const atk = await mkActor(pr, 10n * POS_SCALE);
    const before = await trySim([startWindDown(P, { market: pr.mkt, caller: atk.o.publicKey })], [atk.o]);
    say(`     StartWindDown while oracle FRESH (attacker, not admin) -> ${before === null ? "ALLOWED" : leanErrorName(before as number)}`);
    await waitSlots(Number(pr.maxStale) + 6);
    const after = await trySim([startWindDown(P, { market: pr.mkt, caller: atk.o.publicKey })], [atk.o]);
    if (after === null) rec("amm-vault", "permissionless wind-down kill (keeper outage)", "INFO", `once oracle age > maxStaleness, ANY attacker can StartWindDown (irreversible): vault goes WindDown, no new trades; it is griefing (no funds captured). Fresh-oracle attempt was ${before === null ? "also allowed" : leanErrorName(before as number)}`);
    else rec("amm-vault", "permissionless wind-down kill (keeper outage)", "BLOCKED", `attacker StartWindDown rejected ${leanErrorName(after as number)} even when stale`);
    await push(pr, 60_000);
  }
}

// ================================================================= USER POSITION surface
async function userSurface() {
  say("\n================ USER POSITION surface ================");
  const pr = await standUp({ price: 60_000, vaultCap: 2_000n * POS_SCALE });
  // the user opens a healthy long against the vault
  const user = await mkActor(pr, 40n * POS_SCALE);
  await fill(pr, user, TRADE_MODE.NETTED, true, 1_000n);
  const attacker = Keypair.generate();

  // U1 — unauthorized withdraw (attacker signs for the user's portfolio)
  const c1 = await trySim([withdrawCollateral(P, pr.V, { portfolio: user.p, owner: attacker.publicKey, destToken: pr.fTok, amount: 1n * POS_SCALE })], [attacker]);
  blocked("user", "unauthorized WithdrawCollateral (wrong owner)", c1, 111);

  // U2 — unauthorized close: attacker tries to drive the user's leg via a matcher trade it signs for the user
  //      (the taker signer must equal the portfolio owner)
  const legs = [{ market: pr.mkt, marketId: pr.marketId, mode: TRADE_MODE.CLOSE, takerIsLong: true, maxQty: 1_000n, markPrice: (await mktOf(pr.mkt)).markPrice, maxMoveBps: 100n }];
  const raw = vault.rawTakerFill({ percolator: P, dex: pr.dex, taker: attacker.publicKey, takerPortfolio: user.p, lpPortfolio: pr.lpPfl, ctx: pr.ctx, legs });
  const c2 = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: pr.lpPfl }), raw], [attacker]);
  blocked("user", "unauthorized matcher trade on the user's portfolio (wrong signer)", c2, 111);

  // U3 — liquidate a healthy user
  const c3 = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: user.p }), liquidate(P, pr.V, { market: pr.mkt, portfolio: user.p, liquidatorToken: pr.fTok })], []);
  blocked("user", "liquidate a HEALTHY user position", c3, 116);

  // U4 — force a liquidation by moving the oracle as a NON-oracle key
  const c4 = await trySim([updateOracle(P, { market: pr.mkt, oracleAuth: attacker.publicKey, price: e6(40_000) })], [attacker]);
  blocked("user", "oracle manipulation to force liquidation (non-oracle signer)", c4, 102);

  // U5 — funding-engine wash: a CreateMarket whose maxFund*decay exceeds the fee budget
  const washMkt = await newAcc(P, MARKET_SIZE);
  const washCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1441 });
  const c5 = await trySim([createMarket(P, { dex: pr.dex, market: washMkt, mint: pr.mint, oracleAuth: Keypair.generate().publicKey, creator: funder.publicKey, creatorToken: pr.fTok, feeVault: pr.feeVault, params: { ...r5params(e6(60_000), 300n), fundingCfg: washCfg } })], []);
  blocked("user", "funding-engine wash (maxFund*decay > fee budget)", c5, 103);

  // U6 — position hand-off modes 2/3 via TradeWithMatcher (should be rejected by core)
  for (const mode of [2, 3]) {
    const d = Buffer.alloc(20); d.writeUInt8(IX.TradeWithMatcher, 0); d.writeUInt8(1, 1);
    d.writeUInt8(mode, 2); d.writeUInt8(1, 3); d.writeBigUInt64LE(1_000n, 4); d.writeBigUInt64LE(0n, 12);
    const ixRaw = new TransactionInstruction({ programId: P, data: d, keys: [
      { pubkey: pr.dex, isSigner: false, isWritable: true }, { pubkey: user.p, isSigner: false, isWritable: true },
      { pubkey: user.o.publicKey, isSigner: true, isWritable: false }, { pubkey: pr.lpPfl, isSigner: false, isWritable: true },
      { pubkey: M, isSigner: false, isWritable: false }, { pubkey: pr.ctx, isSigner: false, isWritable: true },
      { pubkey: pr.mkt, isSigner: false, isWritable: true } ] });
    const c6 = await trySim([refreshLeg(P, { dex: pr.dex, market: pr.mkt, portfolio: pr.lpPfl }), ixRaw], [user.o]);
    blocked("user", `TradeWithMatcher hand-off mode ${mode}`, c6, 103);
  }
}

async function main() {
  await assertDevnet(conn);
  say(`ROUND-5 ATTACK CATALOGUE — percolator ${P.toBase58()} matcher ${M.toBase58()} (${vault.name})`);
  if (!ONLY || ONLY === "ins") await insuranceSurface();
  if (!ONLY || ONLY === "amm" || ONLY === "latency") await ammSurface();
  if (!ONLY || ONLY === "user") await userSurface();

  // ---- summary table
  say("\n================ ATTACK SUMMARY ================");
  for (const r of rows) say(`  ${r.verdict.padEnd(9)} | ${r.surface.padEnd(11)} | ${r.attack} — ${r.detail}`);
  const lt = (globalThis as any).__latencyTable as { half: bigint; maxFill: string; dBps: number; lpLoss: string; atkProfit: string }[] | undefined;
  if (lt?.length) {
    say("\n  latency-arbitrage table (LP loss / attacker net per event):");
    say("    halfSpread | maxFill(BTC) | jump(bps) | LP loss | attacker net");
    for (const r of lt) say(`    ${String(r.half).padStart(9)} | ${r.maxFill.padStart(12)} | ${String(r.dBps).padStart(8)} | ${r.lpLoss.padStart(8)} | ${r.atkProfit}`);
  }
  const extracted = rows.filter((r) => r.verdict === "EXTRACTED");
  say(`\n${rows.length} attacks: ${rows.filter((r) => r.verdict === "BLOCKED").length} BLOCKED, ${extracted.length} EXTRACTED, ${rows.filter((r) => r.verdict === "INFO").length} INFO`);
  fs.writeFileSync(process.env.R5_ATTACK_OUT ?? "/tmp/lean-round5-attacks.json", JSON.stringify({ rows, latencyTable: lt ?? [] }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(0);
}
main().catch((e) => { console.error(maskSecrets(String(e)).slice(0, 800)); process.exit(1); });
