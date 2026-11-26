/** "Boring" perp order-management: open, scale-in, partial close, full close, realize+withdraw
 *  profit (withdraw MORE than deposited), and flip/slot-reuse (long -> short in the same slot). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, withdrawCollateral, trade, refreshLeg,
  deriveDexVault, parseDex, parsePortfolio, parseMarket, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const pf = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data));
const oi = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data)).oiLong;
async function waitSlot() { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) <= s) await sleep(300); }
async function conserved(dex: PublicKey, V: VaultAccounts) { const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data)); const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount); return d.vaultBalance === spl; }
const U = (n: bigint) => Number(n) / 1e6;

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  const params: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 400n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const oA = Keypair.generate(), oB = Keypair.generate();
  const pA = await newAcc(P, PORTFOLIO_SIZE), pB = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pA, owner: oA.publicKey })], [oA]);
  await send([initPortfolio(P, { dex, portfolio: pB, owner: oB.publicKey })], [oB]);
  await send([depositCollateral(P, V, { portfolio: pA, depositor: funder.publicKey, sourceToken: fTok, amount: 300n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pB, depositor: funder.publicKey, sourceToken: fTok, amount: 300n * POS_SCALE })]);
  ok((await pf(pA)).capital === 300n * POS_SCALE, "DEPOSIT: A capital = 300");

  const trd = (q: bigint, mode: number) => trade(P, { dex, market: mkt, longPortfolio: pA, longOwner: oA.publicKey, shortPortfolio: pB, shortOwner: oB.publicKey, mode, qty: q });
  // OPEN A long 4 / B short 4
  await send([trd(4n * POS_SCALE, TRADE_MODE.OPEN)], [oA, oB], false);
  let a = await pf(pA);
  ok(a.legs.length === 1 && a.legs[0].sideName === "long" && a.legs[0].rawBasis === 4n * POS_SCALE, "OPEN: A long, rawBasis 4");
  ok((await oi(mkt)) === 4n * POS_SCALE, "OPEN: market OI = 4");

  // SCALE-IN +2 -> 6
  await send([trd(2n * POS_SCALE, TRADE_MODE.OPEN)], [oA, oB], false);
  ok((await pf(pA)).legs[0].rawBasis === 6n * POS_SCALE, "SCALE-IN: rawBasis 4 -> 6");

  // PARTIAL CLOSE 2 -> 4
  await send([trd(2n * POS_SCALE, TRADE_MODE.CLOSE)], [oA, oB], false);
  a = await pf(pA);
  ok(a.legs.length === 1 && a.legs[0].rawBasis === 4n * POS_SCALE, "PARTIAL CLOSE: rawBasis 6 -> 4 (still long)");

  // price +$4 -> $104, refresh: A long gains 4*$4 = $16 realized
  await waitSlot();
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 104n * POS_SCALE })], [oracle]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pB })]); // loser (short) first
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pA })]);
  const capAfterGain = (await pf(pA)).capital;
  ok(Math.abs(U(capAfterGain) - 316) <= 0.5, `REALIZE: A capital 300 -> ~316 (+$16 long profit) — got ${U(capAfterGain)}`);

  // FULL CLOSE remaining 4 @ $104 -> flat, OI 0
  await send([trd(4n * POS_SCALE, TRADE_MODE.CLOSE)], [oA, oB], false);
  a = await pf(pA);
  ok(a.legs.length === 0, "FULL CLOSE: A flat (no active legs)");
  ok((await oi(mkt)) === 0n, "FULL CLOSE: market OI = 0");

  // WITHDRAW profit: pull ALL of A's capital (~320 > 300 deposited)
  const bal0 = (await getAccount(conn, fTok)).amount;
  const capNow = (await pf(pA)).capital;
  await send([withdrawCollateral(P, V, { portfolio: pA, owner: oA.publicKey, destToken: fTok, amount: capNow })], [oA]);
  const bal1 = (await getAccount(conn, fTok)).amount;
  ok((await pf(pA)).capital === 0n, "WITHDRAW: A capital -> 0");
  ok(Number(bal1 - bal0) / 1e6 > 300, `WITHDRAW-PROFIT: withdrew ${U(capNow)} (> 300 deposited) back to wallet`);

  // FLIP / SLOT REUSE: re-deposit and open A as SHORT now (was long)
  await send([depositCollateral(P, V, { portfolio: pA, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pB, longOwner: oB.publicKey, shortPortfolio: pA, shortOwner: oA.publicKey, mode: TRADE_MODE.OPEN, qty: 3n * POS_SCALE })], [oB, oA], false);
  a = await pf(pA);
  ok(a.legs.length === 1 && a.legs[0].sideName === "short" && a.legs[0].rawBasis === 3n * POS_SCALE, "FLIP: A reused same portfolio as SHORT 3 (was long)");

  ok(await conserved(dex, V), "conservation V==SPL at end");
  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("BORING PERP FEATURES WORK: open, scale-in, partial/full close, realize+withdraw profit, flip/reuse — all correct, conserved.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
