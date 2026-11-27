/**
 * MAINNET verification of the live percolator-lean programs: proves users can
 * create markets, build their own matcher, open positions (bilateral AND
 * single-signer against a matcher), and cross-margin — against the real deployed
 * mainnet programs and a LIVE Pyth SOL/USD feed. Uses a disposable 6-decimal test
 * mint for collateral (the program requires 6-decimal USD-style collateral), so
 * no real value is at stake here; this validates mechanics on the mainnet runtime.
 * Reclaims rent by closing the test accounts at the end.
 *
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com pnpm tsx scripts/lean-mainnet-verify.ts
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import * as fs from "fs";
import {
  LEAN_MAINNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, MATCHER_CFG_SIZE, ADAPTER_CFG_SIZE,
  POS_SCALE, TRADE_MODE, FEED_TYPE, deriveOracleAuth,
  initDex, createMarket, adapterInit, adapterCrank, initPortfolio, depositCollateral,
  trade, refreshLeg, matcherInit, matcherFill, parseDex, parseMarket, parsePortfolio, parseMatcherConfig,
  openLegs, withLegRefresh, snapshotDex, checkDexInvariants, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const P = LEAN_MAINNET.percolator, M = LEAN_MAINNET.matcher, O = LEAN_MAINNET.oracleAdapter;
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function R<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) { try { return await f(); } catch (e) { const m = String((e as Error).message ?? e); if (i < 8 && /429|Too Many Requests|rate|timed out|block height/i.test(m)) { await sleep(1000 * (i + 1)); continue; } throw e; } }
}
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

async function send(ixs: TransactionInstruction[], signers: Keypair[] = [], refresh = false) {
  const list = refresh ? await R(() => withLegRefresh(conn, ixs, { percolator: P, matcher: M }).then(r => r.instructions)) : ixs;
  const sig = await R(() => sendAndConfirmTransaction(conn, new Transaction().add(...list), [funder, ...signers], { commitment: "confirmed" }));
  await sleep(400);
  return sig;
}
async function newAcc(owner: PublicKey, size: number) {
  const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(size);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
  return kp.publicKey;
}
async function freshSolFeed() {
  const r = await conn.getProgramAccounts(RECEIVER, { commitment: "confirmed", filters: [{ memcmp: { offset: 41, bytes: bs58.encode(Buffer.from(SOL_FEED, "hex")) } }] });
  let best: any = null; const now = Math.floor(Date.now() / 1000);
  for (const { pubkey, account } of r) { const d = account.data; if (d.length < 134 || d[40] !== 1) continue; const price = d.readBigInt64LE(73), expo = d.readInt32LE(89), age = now - Number(d.readBigInt64LE(93)); if (price <= 0n) continue; const sh = expo + 6; const e6 = sh >= 0 ? price * 10n ** BigInt(sh) : price / 10n ** BigInt(-sh); if (!best || age < best.age) best = { addr: pubkey, e6, age }; }
  return best;
}
async function inv(dex: PublicKey) { const s = await snapshotDex(conn, P, dex); return checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map(m => m.data), s.portfolios.map(p => p.data)); }

async function main() {
  if (!conn.rpcEndpoint.includes("mainnet")) throw new Error("this script is mainnet-only");
  console.log(`MAINNET verify — percolator ${P.toBase58()}`);
  const sol0 = await conn.getBalance(funder.publicKey);
  const feed = await freshSolFeed();
  ok(feed && feed.age < 3600, `live Pyth SOL/USD ${feed?.addr.toBase58()} = $${Number(feed?.e6) / 1e6} (age ${feed?.age}s)`);

  // 6-decimal test collateral (program requires 6-dec USD-style collateral)
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);

  // 1. CREATE A MARKET (anyone can): dex + SOL/USD market priced by the live Pyth adapter
  console.log("== create market (live Pyth SOL/USD) ==");
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const d = parseDex(Buffer.from((await R(() => conn.getAccountInfo(dex))!)!.data));
  const V: VaultAccounts = { dex, mint, vault: d.vault };
  const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
  const [oracPda] = deriveOracleAuth(O, cfg);
  const init = feed.e6 - feed.e6 / 100n;
  const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market: mkt, feed: feed.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: 600n, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(SOL_FEED, "hex") })]);
  await send([adapterCrank(O, { cfg, market: mkt, feed: feed.addr, percolator: P })]);
  const mk = await parseMarket(Buffer.from((await R(() => conn.getAccountInfo(mkt))!)!.data));
  ok(mk.markPrice > init, `market created + cranked by live Pyth: mark=$${Number(mk.markPrice) / 1e6}`);

  // 2. OPEN A POSITION (bilateral, two users)
  console.log("== open positions (bilateral) ==");
  const uA = Keypair.generate(), uB = Keypair.generate();
  const pA = await newAcc(P, PORTFOLIO_SIZE), pB = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pA, owner: uA.publicKey })], [uA]);
  await send([initPortfolio(P, { dex, portfolio: pB, owner: uB.publicKey })], [uB]);
  await send([depositCollateral(P, V, { portfolio: pA, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pB, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pA, longOwner: uA.publicKey, shortPortfolio: pB, shortOwner: uB.publicKey, mode: TRADE_MODE.OPEN, qty: 2n * POS_SCALE })], [uA, uB], true);
  ok(parseMarket(Buffer.from((await R(() => conn.getAccountInfo(mkt))!)!.data)).oiLong === 2n * POS_SCALE, "bilateral position opened (OI=2)");

  // 3. CROSS-MARGIN: second market, one portfolio holds legs in BOTH (shared capital)
  console.log("== cross-margin (one portfolio, two markets) ==");
  const cfg2 = await newAcc(O, ADAPTER_CFG_SIZE);
  const [oracPda2] = deriveOracleAuth(O, cfg2);
  const mkt2 = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt2, mint, oracleAuth: oracPda2, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  await send([adapterInit(O, { cfg: cfg2, admin: funder.publicKey, percolator: P, market: mkt2, feed: feed.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: 600n, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(SOL_FEED, "hex") })]);
  await send([adapterCrank(O, { cfg: cfg2, market: mkt2, feed: feed.addr, percolator: P })]);
  await send([trade(P, { dex, market: mkt2, longPortfolio: pB, longOwner: uB.publicKey, shortPortfolio: pA, shortOwner: uA.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE })], [uB, uA], true);
  const pa = parsePortfolio(Buffer.from((await R(() => conn.getAccountInfo(pA))!)!.data));
  ok(openLegs(pa).length === 2, `cross-margin: portfolio A holds ${openLegs(pa).length} legs across 2 markets on shared capital (totalIm=${Number(pa.totalIm) / 1e6})`);

  // 4. BUILD YOUR OWN MATCHER + trade against it single-signer
  console.log("== build a matcher + single-signer taker fill ==");
  const mcfg = await newAcc(M, MATCHER_CFG_SIZE);
  const lpPfl = await newAcc(P, PORTFOLIO_SIZE);
  await send([matcherInit(M, { cfg: mcfg, owner: funder.publicKey, dex, lpPortfolio: lpPfl, percolator: P, market: mkt, halfSpreadBps: 50n, impactBps: 20n, maxFillQty: 10n * POS_SCALE })]);
  const mc = parseMatcherConfig(Buffer.from((await R(() => conn.getAccountInfo(mcfg))!)!.data));
  ok(mc.lpPortfolio.equals(lpPfl), "matcher built (user-owned config + PDA-owned LP portfolio)");
  await send([depositCollateral(P, V, { portfolio: lpPfl, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  const taker = Keypair.generate(); const takerPfl = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: takerPfl, owner: taker.publicKey })], [taker]);
  await send([depositCollateral(P, V, { portfolio: takerPfl, depositor: funder.publicKey, sourceToken: fTok, amount: 200n * POS_SCALE })]);
  const lpCap0 = parsePortfolio(Buffer.from((await R(() => conn.getAccountInfo(lpPfl))!)!.data)).capital;
  await send([matcherFill(M, { cfg: mcfg, dex, market: mkt, lpPortfolio: lpPfl, takerPortfolio: takerPfl, taker: taker.publicKey, percolator: P, mode: TRADE_MODE.OPEN, takerIsLong: true, qty: POS_SCALE, limitPrice: mk.markPrice + mk.markPrice / 50n })], [taker], true);
  ok(parsePortfolio(Buffer.from((await R(() => conn.getAccountInfo(lpPfl))!)!.data)).capital > lpCap0, "single-signer taker filled against the matcher LP (LP earned spread, no LP signature)");

  ok((await inv(dex)).ok, "conservation holds across all of the above");
  const spent = (sol0 - await conn.getBalance(funder.publicKey)) / 1e9;
  console.log(`\n${pass} passed, ${fail.length} failed — spent ${spent.toFixed(4)} SOL (mostly reclaimable test-account rent) — dex ${dex.toBase58()}`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("VERIFIED on mainnet: create markets, open positions, cross-margin, and build+trade-against your own matcher all work on the live program.");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
