/**
 * Randomized conservation fuzzer for the live percolator-lean program.
 *
 * Complements the targeted harnesses (`lean-attack.ts`, `lean-bounty-validate.ts`): instead of
 * one scripted exploit, it stands up a self-owned DEX + market (with the caller as `oracleAuth`,
 * so it can drive clamped price moves to force liquidations) plus an insurance pot, then fires
 * long random sequences of every value-moving handler and re-checks `checkDexInvariants`
 * (`V == SPL vault`, `C+I+R+S == V`, per-market/portfolio coherence) after EVERY successful tx.
 * The first break prints the triggering action log and writes `lean-fuzz-break.json`.
 *
 * Three surfaces:
 *   (1) single handlers      — trade open/reduce/handoff, oracle moves, liquidate, (in|out) collateral
 *                              and insurance, refresh, clearDeadLeg.
 *   (2) atomic bundles        — several handlers in ONE tx (oracle+liquidate, deposit+trade+withdraw,
 *                              open+oracle+reduce), probing intra-tx sequencing.
 *   (3) malformed accounts    — deliberately wrong accounts that MUST be rejected (noop/Token-2022 as
 *                              tokProg, wrong mint/vault, aliased accounts, type-confused receipt,
 *                              closing a live account). A success here is logged loudly.
 *
 * Uses a disposable 6-decimal test mint, so no real value is at stake. Needs a funded keypair.
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com FUNDER=~/.config/solana/id.json \
 *     ITERS=2000 pnpm tsx scripts/lean-fuzz.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, MATCHER_CFG_SIZE,
  POS_SCALE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, withdrawCollateral,
  depositInsurance, withdrawInsurance, trade, liquidate, refreshLeg, clearDeadLeg, closeAccount,
  matcherInit, matcherFill, matcherUpdate, matcherWithdrawLp,
  parseDex, parseMarket, parsePortfolio, checkDexInvariants,
  withLegRefresh, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ITERS = Number(process.env.ITERS ?? 2000);
const NPORT = Number(process.env.NPORT ?? 4);
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const TOKEN2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const conn = new Connection(RPC, "confirmed");
const P = LEAN_DEVNET.percolator, MPROG = LEAN_DEVNET.matcher;
if (!process.env.FUNDER) throw new Error("set FUNDER=/path/to/keypair.json (a funded keypair)");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER, "utf8"))));
const oracle = Keypair.generate();   // dedicated oracleAuth (must not alias the market creator)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: T[]) => a[rnd(a.length)];

process.on("unhandledRejection", (e) => { console.log("unhandledRejection (continuing):", String((e as any)?.message ?? e).slice(0, 80)); });
async function R<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); }
    catch (e) { const m = String((e as Error).message ?? e); if (i < 15 && /429|Too Many|rate|timed out|block height|expired|fetch failed|ECONN|socket/i.test(m)) { await sleep(600 * (i + 1)); continue; } throw e; }
  }
}
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 });
async function send(ixs: TransactionInstruction[], signers: Keypair[] = [], refresh = false) {
  const list = refresh ? await R(() => withLegRefresh(conn, ixs, { percolator: P }).then(r => r.instructions)) : ixs;
  return R(() => sendAndConfirmTransaction(conn, new Transaction().add(CU, ...list), [funder, ...signers], { commitment: "confirmed" }));
}
async function newAcc(owner: PublicKey, size: number) {
  const kp = Keypair.generate(); const lam = await R(() => conn.getMinimumBalanceForRentExemption(size));
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
  return kp.publicKey;
}

type Port = { pk: PublicKey; id: number };
let dex!: PublicKey, mkt!: PublicKey, V!: VaultAccounts, fTok!: PublicKey, insReceipt!: PublicKey;
let wrongMint!: PublicKey, attackerTok!: PublicKey;
let mcfg!: PublicKey, lpPfl!: PublicKey, matcherOk = false;
let markPrice = 1_000_000n; const MAXMOVE = 400n;
const ports: Port[] = [];
const log: string[] = [];
const push = (s: string) => { log.push(s); if (log.length > 60) log.shift(); };
const counts: Record<string, number> = {};
let okTx = 0, failTx = 0, malformedSucceeded = 0;

async function inv() {
  const metas = [dex, mkt, ...ports.map(p => p.pk), ...(matcherOk ? [lpPfl] : [])];
  const infos = await R(() => conn.getMultipleAccountsInfo(metas, "confirmed"));
  const dexData = parseDex(Buffer.from(infos[0]!.data));
  const mktData = parseMarket(Buffer.from(infos[1]!.data));
  const portData = infos.slice(2).filter(Boolean).map(i => parsePortfolio(Buffer.from(i!.data)));
  const vaultBal = BigInt((await R(() => conn.getTokenAccountBalance(dexData.vault, "confirmed"))).value.amount);
  return checkDexInvariants(dexData, vaultBal, [mktData], portData);
}
const market = async () => parseMarket(Buffer.from((await R(() => conn.getAccountInfo(mkt)))!.data));
const clampNext = (up: boolean, mp: bigint) => { const s = (mp * MAXMOVE) / 10_000n; const d = BigInt(rnd(Number(s) + 1)); const np = up ? mp + d : (mp > d ? mp - d : mp / 2n); return np < 1n ? 1n : np; };
const q10 = () => BigInt(1 + rnd(40)) * (POS_SCALE / 10n);

async function setup() {
  const bal = await R(() => conn.getBalance(funder.publicKey));
  console.log(`lean-fuzz — funder ${funder.publicKey.toBase58()} ${bal / 1e9} SOL — program ${P.toBase58()}`);
  if (bal < 0.3e9) throw new Error("funder underfunded (a couple of SOL covers rent + fees)");
  const mint = await R(() => createMint(conn, funder, funder.publicKey, null, 6));
  wrongMint = await R(() => createMint(conn, funder, funder.publicKey, null, 6));
  const feeVault = await R(() => createAccount(conn, funder, mint, funder.publicKey, Keypair.generate()));
  fTok = await R(() => createAccount(conn, funder, mint, funder.publicKey, Keypair.generate()));
  attackerTok = await R(() => createAccount(conn, funder, mint, funder.publicKey, Keypair.generate()));
  await R(() => mintTo(conn, funder, mint, fTok, funder, 10_000_000n * POS_SCALE));

  dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  V = { dex, mint, vault: parseDex(Buffer.from((await R(() => conn.getAccountInfo(dex)))!.data)).vault };

  mkt = await newAcc(P, MARKET_SIZE);
  const params: MarketParams = { initPrice: markPrice, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: MAXMOVE, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  insReceipt = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: insReceipt, lp: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);

  for (let i = 0; i < NPORT; i++) {
    const pk = await newAcc(P, PORTFOLIO_SIZE);
    await send([initPortfolio(P, { dex, portfolio: pk, owner: funder.publicKey })]);
    await send([depositCollateral(P, V, { portfolio: pk, depositor: funder.publicKey, sourceToken: fTok, amount: 1000n * POS_SCALE })]);
    ports.push({ pk, id: i });
  }
  // matcher is auxiliary (it CPIs core Trade); optional — skip surface (2b) if its build rejects init
  try {
    mcfg = await newAcc(MPROG, MATCHER_CFG_SIZE);
    lpPfl = await newAcc(P, PORTFOLIO_SIZE);
    await send([matcherInit(MPROG, { cfg: mcfg, owner: funder.publicKey, dex, lpPortfolio: lpPfl, percolator: P, market: mkt, halfSpreadBps: 50n, impactBps: 20n, maxFillQty: 20n * POS_SCALE })]);
    await send([depositCollateral(P, V, { portfolio: lpPfl, depositor: funder.publicKey, sourceToken: fTok, amount: 2000n * POS_SCALE })]);
    matcherOk = true;
  } catch (e) { console.log("matcher init skipped:", String((e as any)?.message ?? e).slice(0, 70)); }

  const r0 = await inv();
  console.log(`setup done — dex ${dex.toBase58()} market ${mkt.toBase58()} — invariant ${r0.ok ? "OK" : "BROKEN " + r0.problems.join(";")}`);
  if (!r0.ok) throw new Error("invariant broken at setup");
}

// (2) atomic multi-instruction bundles
function bundle(): { ixs: TransactionInstruction[]; refresh: boolean; signers: Keypair[]; name: string } {
  const a = pick(ports); const b = pick(ports.filter(p => p.id !== a.id)); const qty = q10();
  switch (rnd(5)) {
    case 0: { const np = clampNext(Math.random() < 0.5, markPrice); return { name: "oracle+liquidate", refresh: true, signers: [oracle], ixs: [updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: np }), liquidate(P, V, { market: mkt, portfolio: pick(ports).pk, liquidatorToken: fTok })] }; }
    case 1: return { name: "deposit+open+withdraw", refresh: true, signers: [], ixs: [
      depositCollateral(P, V, { portfolio: a.pk, depositor: funder.publicKey, sourceToken: fTok, amount: BigInt(1 + rnd(200)) * POS_SCALE }),
      trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: b.pk, shortOwner: funder.publicKey, mode: 0, qty }),
      withdrawCollateral(P, V, { portfolio: a.pk, owner: funder.publicKey, destToken: fTok, amount: BigInt(1 + rnd(150)) * POS_SCALE }) ] };
    case 2: { const np = clampNext(Math.random() < 0.5, markPrice); return { name: "open+oracle+reduce", refresh: true, signers: [oracle], ixs: [
      trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: b.pk, shortOwner: funder.publicKey, mode: 0, qty }),
      updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: np }),
      trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: b.pk, shortOwner: funder.publicKey, mode: 1, qty }) ] }; }
    case 3: return { name: "refresh+withdraw", refresh: false, signers: [], ixs: [
      refreshLeg(P, { dex, market: mkt, portfolio: a.pk }),
      withdrawCollateral(P, V, { portfolio: a.pk, owner: funder.publicKey, destToken: fTok, amount: BigInt(1 + rnd(200)) * POS_SCALE }) ] };
    default: return { name: "insDeposit+insWithdraw", refresh: false, signers: [], ixs: [
      depositInsurance(P, V, { market: mkt, receipt: insReceipt, lp: funder.publicKey, sourceToken: fTok, amount: BigInt(1 + rnd(40)) * POS_SCALE }),
      withdrawInsurance(P, V, { market: mkt, receipt: insReceipt, lp: funder.publicKey, destToken: fTok, burnShares: BigInt(1 + rnd(40)) * POS_SCALE }) ] };
  }
}

// (3) malformed / substituted accounts — all MUST be rejected; owner-independent cases only
function malformed(): { ix: TransactionInstruction; name: string } {
  const a = pick(ports); const amt = BigInt(1 + rnd(100)) * POS_SCALE;
  const dep = () => depositCollateral(P, V, { portfolio: a.pk, depositor: funder.publicKey, sourceToken: fTok, amount: amt });
  const wd = () => withdrawCollateral(P, V, { portfolio: a.pk, owner: funder.publicKey, destToken: fTok, amount: amt });
  switch (rnd(9)) {
    case 0: { const ix = dep(); ix.keys[6].pubkey = NOOP; return { ix, name: "dep:tokProg=noop" }; }
    case 1: { const ix = dep(); ix.keys[6].pubkey = TOKEN2022; return { ix, name: "dep:tokProg=token2022" }; }
    case 2: { const ix = dep(); ix.keys[4].pubkey = wrongMint; return { ix, name: "dep:wrongMint" }; }
    case 3: { const ix = dep(); ix.keys[5].pubkey = attackerTok; return { ix, name: "dep:vault=attackerTok" }; }
    case 4: { const ix = wd(); ix.keys[5].pubkey = attackerTok; return { ix, name: "wd:vault=attackerTok" }; }
    case 5: { const ix = wd(); ix.keys[3].pubkey = V.vault; return { ix, name: "wd:destTok=vault(alias)" }; }
    case 6: { const ix = trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: a.pk, shortOwner: funder.publicKey, mode: 0, qty: POS_SCALE }); return { ix, name: "trade:aliasedPorts" }; }
    case 7: { const ix = depositInsurance(P, V, { market: mkt, receipt: insReceipt, lp: funder.publicKey, sourceToken: fTok, amount: amt }); ix.keys[2].pubkey = a.pk; return { ix, name: "insDep:receipt=portfolio" }; }
    default: return { ix: closeAccount(P, { account: a.pk, authority: funder.publicKey, destination: funder.publicKey }), name: "close:livePortfolio" };
  }
}

async function step() {
  const kind = pick(["single", "single", "bundle", "bundle", "malformed", "malformed", "matcher"]);
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (kind === "single") {
    const a = pick(ports), b = pick(ports.filter(p => p.id !== a.id));
    switch (rnd(9)) {
      case 0: { markPrice = (await market()).markPrice; await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: clampNext(Math.random() < 0.5, markPrice) })], [oracle]); push("oracle"); break; }
      case 1: await send([trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: b.pk, shortOwner: funder.publicKey, mode: 0, qty: q10() })], [], true); push("open"); break;
      case 2: await send([trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: b.pk, shortOwner: funder.publicKey, mode: 1, qty: q10() })], [], true); push("reduce"); break;
      case 3: await send([trade(P, { dex, market: mkt, longPortfolio: a.pk, longOwner: funder.publicKey, shortPortfolio: b.pk, shortOwner: funder.publicKey, mode: Math.random() < 0.5 ? 2 : 3, qty: q10() })], [], true); push("handoff"); break;
      case 4: await send([liquidate(P, V, { market: mkt, portfolio: a.pk, liquidatorToken: fTok })], [], true); push("liquidate"); break;
      case 5: await send([depositCollateral(P, V, { portfolio: a.pk, depositor: funder.publicKey, sourceToken: fTok, amount: BigInt(1 + rnd(300)) * POS_SCALE })]); push("deposit"); break;
      case 6: await send([withdrawCollateral(P, V, { portfolio: a.pk, owner: funder.publicKey, destToken: fTok, amount: BigInt(1 + rnd(200)) * POS_SCALE })], [], true); push("withdraw"); break;
      case 7: await send([Math.random() < 0.5
        ? depositInsurance(P, V, { market: mkt, receipt: insReceipt, lp: funder.publicKey, sourceToken: fTok, amount: BigInt(1 + rnd(40)) * POS_SCALE })
        : withdrawInsurance(P, V, { market: mkt, receipt: insReceipt, lp: funder.publicKey, destToken: fTok, burnShares: BigInt(1 + rnd(40)) * POS_SCALE })], [], true); push("insurance"); break;
      default: await send([Math.random() < 0.5 ? refreshLeg(P, { dex, market: mkt, portfolio: a.pk }) : clearDeadLeg(P, { dex, market: mkt, portfolio: a.pk })]); push("refresh/clearDead"); break;
    }
  } else if (kind === "bundle") {
    const b = bundle(); await send(b.ixs, b.signers, b.refresh); push(`bundle:${b.name}`);
  } else if (kind === "matcher") {
    if (!matcherOk) { const b = bundle(); await send(b.ixs, b.signers, b.refresh); push(`bundle:${b.name}`); return; }
    switch (rnd(3)) {
      case 0: { const mk = await market(); await send([matcherFill(MPROG, { cfg: mcfg, dex, market: mkt, lpPortfolio: lpPfl, takerPortfolio: pick(ports).pk, taker: funder.publicKey, percolator: P, mode: rnd(2), takerIsLong: Math.random() < 0.5, qty: BigInt(1 + rnd(15)) * POS_SCALE, limitPrice: Math.random() < 0.5 ? 0n : mk.markPrice + mk.markPrice / 20n })], [], true); push("matcherFill"); break; }
      case 1: await send([matcherUpdate(MPROG, { cfg: mcfg, owner: funder.publicKey, paused: Math.random() < 0.3, halfSpreadBps: BigInt(rnd(500)), impactBps: BigInt(rnd(200)), maxFillQty: BigInt(1 + rnd(30)) * POS_SCALE })]); push("matcherUpdate"); break;
      default: await send([matcherWithdrawLp(MPROG, V, { cfg: mcfg, owner: funder.publicKey, lpPortfolio: lpPfl, destToken: fTok, percolator: P, amount: BigInt(1 + rnd(200)) * POS_SCALE })], [], true); push("matcherWithdrawLp"); break;
    }
  } else { // malformed — reaching here means a supposed-to-fail ix was ACCEPTED
    const m = malformed(); await send([m.ix]);
    malformedSucceeded++; console.log(`  !! malformed ix accepted (inspect): ${m.name}`); push(`MALFORMED-ACCEPTED:${m.name}`);
  }
}

async function main() {
  await setup();
  console.log(`fuzzing ${ITERS} iterations...`);
  for (let i = 0; i < ITERS; i++) {
    try { await step(); okTx++; } catch { failTx++; continue; }  // rejected txs are expected; only successes matter
    const r = await inv();
    if (!r.ok) {
      console.log(`\n==== INVARIANT BROKEN at iter ${i} ====\n${r.problems.join("\n")}\n--- recent actions ---\n${log.join("\n")}\ndex ${dex.toBase58()} market ${mkt.toBase58()}`);
      fs.writeFileSync("lean-fuzz-break.json", JSON.stringify({ problems: r.problems, log, dex: dex.toBase58(), market: mkt.toBase58() }, null, 2));
      process.exit(2);
    }
    if (i % 50 === 0) console.log(`  iter ${i}: ok=${okTx} fail=${failTx} | ${JSON.stringify(counts)}`);
  }
  const r = await inv();
  console.log(`\nDONE ${ITERS} iters, ${okTx} successful txs, ${malformedSucceeded} malformed accepted, invariant ${r.ok ? "held throughout (V==SPL, C+I+R+S==V)" : "BROKEN " + r.problems.join(";")}`);
  process.exit(r.ok ? 0 : 2);
}
main().catch(e => { console.error("fatal:", String(e.message ?? e)); process.exit(1); });
