/** Funding-rate correctness: with price UNCHANGED, applying funding moves exactly qty*fundE6 from
 *  one side to the other (longs->shorts when sign=0, shorts->longs when sign=1), zero-sum, conserved. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, trade, refreshLeg,
  deriveDexVault, parseDex, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const cap = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data)).capital;
async function waitSlot() { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) <= s) await sleep(300); }
async function conserved(dex: PublicKey, V: VaultAccounts) {
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  return d.vaultBalance === spl;
}

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  // maxMove 400bps (4%) so funding up to $10/step at $100 fits the clamp budget
  const params: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 5n * POS_SCALE })], [oL, oS], false);
  console.log(`opened Long5/Short5 @ $100`);

  // --- Funding step 1: sign=0 (LONGS PAY SHORTS), price unchanged, fundE6 = $1 -> transfer = 5*$1 = $5 ---
  // (a056eee maxMove=100bps -> clamp budget at $100 is $1; funding must fit it.)
  let capL = await cap(pL), capS = await cap(pS);
  await waitSlot();
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 100n * POS_SCALE, fundingSign: 0, fundingE6: 1n * POS_SCALE })], [oracle]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pL })]); // loser (long) first -> funds realizedPool
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pS })]);
  let dL = Number((await cap(pL)) - capL) / 1e6, dS = Number((await cap(pS)) - capS) / 1e6;
  console.log(`funding sign=0 fundE6=$1: L Δ=${dL}  S Δ=${dS}  (price unchanged $100)`);
  ok(Math.abs(dL + 5) <= 0.01, `LONGS PAY: long -$5 (qty5 * $1) — got ${dL}`);
  ok(Math.abs(dS - 5) <= 0.01, `shorts receive +$5 — got ${dS}`);
  ok(Math.abs(dL + dS) <= 0.001, `zero-sum (long pays exactly what short receives)`);
  ok(await conserved(dex, V), `conservation V==SPL after funding step 1`);

  // --- Funding step 2: sign=1 (SHORTS PAY LONGS), fundE6 = $0.5 -> transfer = 5*$0.5 = $2.5 ---
  capL = await cap(pL); capS = await cap(pS);
  await waitSlot();
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 100n * POS_SCALE, fundingSign: 1, fundingE6: POS_SCALE / 2n })], [oracle]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pS })]); // loser (short) first
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pL })]);
  dL = Number((await cap(pL)) - capL) / 1e6; dS = Number((await cap(pS)) - capS) / 1e6;
  console.log(`funding sign=1 fundE6=$0.5: L Δ=${dL}  S Δ=${dS}`);
  ok(Math.abs(dL - 2.5) <= 0.01, `SHORTS PAY: long +$2.5 (direction flips) — got ${dL}`);
  ok(Math.abs(dS + 2.5) <= 0.01, `shorts -$2.5 — got ${dS}`);
  ok(await conserved(dex, V), `conservation V==SPL after funding step 2`);

  // --- Clamp: funding beyond maxMove budget must be rejected ---
  await waitSlot();
  let clamped = false;
  try { await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 100n * POS_SCALE, fundingSign: 0, fundingE6: 50n * POS_SCALE })], [oracle]); }
  catch { clamped = true; }
  ok(clamped, "funding > maxMove clamp budget ($50 > $1) is rejected (oracleClamp)");

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("FUNDING WORKS: signed, zero-sum, magnitude = qty*fundE6, clamp-bounded, conserved.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
