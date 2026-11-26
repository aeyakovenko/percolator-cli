/**
 * Real-oracle smoke for percolator-lean f2b8b11 on devnet: drives the native Pyth
 * PriceUpdateV2 parser + 2-leg composite ratio through the oracle_adapter, against
 * REAL on-chain Pyth accounts, and verifies the market mark converges to the parsed
 * price via a permissionless crank.
 *
 * NOTE: devnet Pyth pull accounts are not continuously cranked, so these are real
 * Pyth account bytes but stale timestamps — we set maxFeedAge large to accept them.
 * This proves the parser/crank/clamp/feed-owner-pin on genuine Pyth data; it is not
 * a live-updating feed (devnet has none).
 *
 *   SOLANA_RPC_URL=<devnet> pnpm tsx scripts/lean-oracle-smoke.ts
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, ADAPTER_CFG_SIZE, POS_SCALE, FEED_TYPE,
  assertDevnet, deriveOracleAuth, initDex, createMarket, adapterInit, adapterCrank, adapterInitEwma, adapterInitEwma,
  parseDex, parseMarket, parseAdapterConfig, ADAPTER_FLAG, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = LEAN_DEVNET.percolator, O = LEAN_DEVNET.oracleAdapter;
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const FEED_ID = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
};
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };

/** Pick the freshest real PriceUpdateV2 account for a feed id; return {addr, priceE6, feedIdBuf}. */
async function findPyth(fidHex: string) {
  const res = await conn.getProgramAccounts(RECEIVER, { commitment: "confirmed", filters: [{ memcmp: { offset: 41, bytes: bs58.encode(Buffer.from(fidHex, "hex")) } }] });
  let best: { addr: PublicKey; priceE6: bigint; age: number } | null = null;
  const now = Math.floor(Date.now() / 1000);
  for (const { pubkey, account } of res) {
    const d = account.data;
    if (d.length < 134 || d[40] !== 1) continue;
    const price = d.readBigInt64LE(73), expo = d.readInt32LE(89), pub = Number(d.readBigInt64LE(93));
    if (price <= 0n) continue;
    // priceE6 = price * 10^(expo+6)
    const shift = expo + 6;
    const priceE6 = shift >= 0 ? price * (10n ** BigInt(shift)) : price / (10n ** BigInt(-shift));
    const age = now - pub;
    if (!best || age < best.age) best = { addr: pubkey, priceE6, age };
  }
  if (!best) throw new Error(`no Pyth account for ${fidHex}`);
  return best;
}

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...signers], { commitment: "confirmed" });
}
async function newAcc(owner: PublicKey, size: number) {
  const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(size);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
  return kp.publicKey;
}
const mktOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data));

async function main() {
  await assertDevnet(conn);
  console.log(`lean-oracle-smoke — adapter ${O.toBase58()}`);
  const sol = await findPyth(FEED_ID.SOL);
  const btc = await findPyth(FEED_ID.BTC);
  console.log(`  real Pyth SOL/USD ${sol.addr.toBase58()} = ${Number(sol.priceE6) / 1e6} (age ${(sol.age / 86400).toFixed(0)}d)`);
  console.log(`  real Pyth BTC/USD ${btc.addr.toBase58()} = ${Number(btc.priceE6) / 1e6} (age ${(btc.age / 86400).toFixed(0)}d)`);

  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 1000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const V: VaultAccounts = { dex, mint, vault: d.vault };
  const bigAge = 10_000_000n; // accept stale devnet Pyth (seconds)

  // ---- 1. single-feed Pyth: SOL/USD
  console.log("== 1. native Pyth parse (SOL/USD) ==");
  {
    const target = sol.priceE6;
    const init = target - target / 100n; // 1% below → one 4% crank lands exactly on target
    const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
    const [oracPda] = deriveOracleAuth(O, cfg);
    const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 2000n, mmBps: 1000n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 200n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
    const mkt = await newAcc(P, MARKET_SIZE);
    await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
    await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market: mkt, feed: sol.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: bigAge, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(FEED_ID.SOL, "hex") })]);
    const ac = parseAdapterConfig(Buffer.from((await conn.getAccountInfo(cfg))!.data));
    ok(ac.feedType === FEED_TYPE.PYTH_V2 && ac.feed.equals(sol.addr) && !ac.hasQuote, "adapter inited: PythV2, feed pinned, no quote");
    await send([adapterCrank(O, { cfg, market: mkt, feed: sol.addr, percolator: P })]);
    const mk = await mktOf(mkt);
    const live = (await findPyth(FEED_ID.SOL)).priceE6; // re-read (feed is live, moves each slot)
    const maxStep = init + (init * 400n) / 10_000n;
    ok(mk.markPrice > init && mk.markPrice <= maxStep + 1n, `crank moved mark UP toward live SOL (init=${Number(init)/1e6} -> mark=${Number(mk.markPrice)/1e6}, clamp<=${Number(maxStep)/1e6})`);
    const tol = live / 100n; // within 1% of the live price (it moved since setup)
    ok(mk.markPrice >= live - tol && mk.markPrice <= live + tol, `mark tracks live Pyth SOL ${Number(live)/1e6} (±1%)`);
  }

  // ---- 2. 2-leg composite ratio: BTC/USD ÷ SOL/USD = BTC/SOL (same shape as legacy STOXX/SOL)
  console.log("== 2. composite ratio (BTC/SOL = BTC/USD ÷ SOL/USD) ==");
  {
    const ratio = (btc.priceE6 * POS_SCALE) / sol.priceE6; // floor(base*1e6/quote) in E6
    const init = ratio - ratio / 100n;
    const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
    const [oracPda] = deriveOracleAuth(O, cfg);
    const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 2000n, mmBps: 1000n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 200n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
    const mkt = await newAcc(P, MARKET_SIZE);
    await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
    await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market: mkt, feed: btc.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: bigAge, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(FEED_ID.BTC, "hex"), quoteFeed: sol.addr, quoteFeedType: FEED_TYPE.PYTH_V2, quoteFeedId: Buffer.from(FEED_ID.SOL, "hex") })]);
    const ac = parseAdapterConfig(Buffer.from((await conn.getAccountInfo(cfg))!.data));
    ok(ac.hasQuote && ac.quoteFeed?.equals(sol.addr) === true, "adapter inited: composite with quote feed pinned");
    await send([adapterCrank(O, { cfg, market: mkt, feed: btc.addr, percolator: P, quoteFeed: sol.addr })]);
    const mk = await mktOf(mkt);
    const b2 = (await findPyth(FEED_ID.BTC)).priceE6, s2 = (await findPyth(FEED_ID.SOL)).priceE6;
    const liveRatio = (b2 * POS_SCALE) / s2;
    const tol = liveRatio / 100n;
    ok(mk.markPrice > init && mk.markPrice >= liveRatio - tol && mk.markPrice <= liveRatio + tol, `composite mark tracks live BTC/SOL ${Number(liveRatio)/1e6} (mark=${Number(mk.markPrice)/1e6}, ±1%)`);
  }

  // ---- 3. EWMA smoothing (seed + blend) on real Pyth SOL/USD
  console.log("== 3. EWMA smoothing (alpha=50%, hybrid AH) ==");
  {
    const spot = (await findPyth(FEED_ID.SOL)).priceE6;
    const seed = spot - spot / 20n; // seed 5% below spot
    const init = seed - seed / 100n;
    const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
    const [oracPda] = deriveOracleAuth(O, cfg);
    const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 2000n, mmBps: 1000n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 200n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
    const mkt = await newAcc(P, MARKET_SIZE);
    await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
    await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market: mkt, feed: sol.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: bigAge, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(FEED_ID.SOL, "hex") })]);
    await send([adapterInitEwma(O, { cfg, admin: funder.publicKey, hybridAfterHours: true, alphaBps: 5000n, maxDevBps: 500n, initEwma: seed })]);
    const ac0 = parseAdapterConfig(Buffer.from((await conn.getAccountInfo(cfg))!.data));
    ok(ac0.hybridAfterHours && ac0.ewmaAlphaBps === 5000n && ac0.ewmaPrice === seed, `EWMA inited: hybridAH, alpha=50%, seeded=${Number(ac0.ewmaPrice)/1e6}`);
    await send([adapterCrank(O, { cfg, market: mkt, feed: sol.addr, percolator: P })]);
    const ac1 = parseAdapterConfig(Buffer.from((await conn.getAccountInfo(cfg))!.data));
    // EWMA blend of seed and spot with alpha 50%: strictly between seed and spot (convex, no overshoot)
    const blended = ac1.ewmaPrice;
    ok(blended > seed && blended < spot, `EWMA blended toward spot: seed=${Number(seed)/1e6} -> ewma=${Number(blended)/1e6} -> spot=${Number(spot)/1e6} (convex)`);
    const expect = (seed * 5000n + spot * 5000n) / 10000n;
    const dd = blended > expect ? blended - expect : expect - blended;
    ok(dd <= 1n, `EWMA exact 50/50 blend: ewma=${Number(blended)/1e6} vs computed ${Number(expect)/1e6} (±1)`);
  }

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("CLEAN — native Pyth parse + composite ratio verified on real devnet Pyth data.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
