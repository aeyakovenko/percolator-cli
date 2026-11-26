/** Open-long -> close-long round-trip on the live mainnet program (test mint, real Pyth). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import * as fs from "fs";
import {
  LEAN_MAINNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, ADAPTER_CFG_SIZE, POS_SCALE, TRADE_MODE, FEED_TYPE,
  deriveOracleAuth, initDex, createMarket, adapterInit, adapterCrank, initPortfolio, depositCollateral,
  trade, parseDex, parseMarket, parsePortfolio, openLegs, withLegRefresh, snapshotDex, checkDexInvariants,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_MAINNET.percolator, O = LEAN_MAINNET.oracleAdapter;
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
async function send(ixs: TransactionInstruction[], signers: Keypair[] = [], refresh = false) {
  const list = refresh ? (await withLegRefresh(conn, ixs, { percolator: P })).instructions : ixs;
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...list), [funder, ...signers], { commitment: "confirmed" }); } catch (e) { const m = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|rate|block height|timed out/i.test(m)) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; } throw e; } }
}
async function newAcc(o: PublicKey, s: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(s); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: s, programId: o })], [kp]); return kp.publicKey; }
const mkt = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data));
const pfl = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data));
async function feed() { const r = await conn.getProgramAccounts(RECEIVER, { commitment: "confirmed", filters: [{ memcmp: { offset: 41, bytes: bs58.encode(Buffer.from(SOL_FEED, "hex")) } }] }); let b: any = null; const now = Math.floor(Date.now() / 1000); for (const { pubkey, account } of r) { const d = account.data; if (d.length < 134 || d[40] !== 1) continue; const pr = d.readBigInt64LE(73), ex = d.readInt32LE(89), age = now - Number(d.readBigInt64LE(93)); if (pr <= 0n) continue; const sh = ex + 6; const e6 = sh >= 0 ? pr * 10n ** BigInt(sh) : pr / 10n ** BigInt(-sh); if (!b || age < b.age) b = { addr: pubkey, e6, age }; } return b; }

async function main() {
  const f = await feed();
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const V: VaultAccounts = { dex, mint, vault: d.vault };
  const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
  const [oracPda] = deriveOracleAuth(O, cfg);
  const params: MarketParams = { initPrice: f.e6 - f.e6 / 100n, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 2000n, mmBps: 1000n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 200n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const market = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market, feed: f.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: 600n, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(SOL_FEED, "hex") })]);
  await send([adapterCrank(O, { cfg, market, feed: f.addr, percolator: P })]);

  const A = Keypair.generate(), B = Keypair.generate();
  const pA = await newAcc(P, PORTFOLIO_SIZE), pB = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pA, owner: A.publicKey })], [A]);
  await send([initPortfolio(P, { dex, portfolio: pB, owner: B.publicKey })], [B]);
  await send([depositCollateral(P, V, { portfolio: pA, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pB, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  const capA0 = (await pfl(pA)).capital, capB0 = (await pfl(pB)).capital;

  // OPEN LONG: A long / B short, qty 3
  await send([trade(P, { dex, market, longPortfolio: pA, longOwner: A.publicKey, shortPortfolio: pB, shortOwner: B.publicKey, mode: TRADE_MODE.OPEN, qty: 3n * POS_SCALE })], [A, B], true);
  const mOpen = await mkt(market), pAo = await pfl(pA);
  console.log(`OPEN LONG: OI=${Number(mOpen.oiLong) / 1e6}, A side=${openLegs(pAo)[0].sideName} rawBasis=${Number(openLegs(pAo)[0].rawBasis) / 1e6}`);

  // CLOSE LONG: reduce qty 3 -> flat
  await send([trade(P, { dex, market, longPortfolio: pA, longOwner: A.publicKey, shortPortfolio: pB, shortOwner: B.publicKey, mode: TRADE_MODE.CLOSE, qty: 3n * POS_SCALE })], [A, B], true);
  const mClose = await mkt(market), pAc = await pfl(pA), pBc = await pfl(pB);
  console.log(`CLOSE LONG: OI=${Number(mClose.oiLong) / 1e6}, A openLegs=${openLegs(pAc).length}, A cap=${Number(pAc.capital) / 1e6} (was ${Number(capA0) / 1e6}), B cap=${Number(pBc.capital) / 1e6} (was ${Number(capB0) / 1e6})`);

  const s = await snapshotDex(conn, P, dex);
  const inv = checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map(m => m.data), s.portfolios.map(p => p.data));
  const okRound = mOpen.oiLong === 3n * POS_SCALE && mClose.oiLong === 0n && openLegs(pAc).length === 0 && inv.ok;
  console.log(okRound ? "✅ open-long -> close-long round-trip WORKS on mainnet (OI 3->0, position flat, conservation holds)" : "❌ FAILED: " + (inv.ok ? "" : inv.problems.join("; ")));
  process.exit(okRound ? 0 : 1);
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
