/** 9b45ad1 built-in HL/Binance funding engine (fundingCfg != 0) on devnet:
 *  - CreateMarket accepts a valid packed fundingCfg, rejects a wash-positive one;
 *  - with price unchanged and premium ~0, longs pay shorts the base interest (+0.01%/8h) pro-rata to elapsed slots;
 *  - zero-sum (long pays exactly what short receives, +-rounding), conserved;
 *  - external fundE6 injection is rejected while built-in funding is on. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE, SLOTS_PER_8H,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, trade, refreshLeg, packFundingCfg,
  deriveDexVault, parseDex, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function rejects(ixs: TransactionInstruction[], s: Keypair[], code: number) { try { await send(ixs, s); return "succeeded"; } catch (e) { const m = String(e); return m.includes(`0x${code.toString(16)}`) ? "ok" : m.slice(0, 90); } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const cap = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data)).capital;
const mktOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data));

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 }); // +0.01%/8h, ±0.05%, ±1%/8h cap
  const base: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };

  // wash-positive cfg: 100 * 1441 > 2 * 72000 -> must reject (invalidParams 103)
  const bad = await newAcc(P, MARKET_SIZE);
  const r0 = await rejects([createMarket(P, { dex, market: bad, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: { ...base, fundingCfg: packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1441 }) } })], [], 103);
  ok(r0 === "ok", `wash-positive fundingCfg (decay 1441 > budget) rejected — ${r0}`);

  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: { ...base, fundingCfg } })]);
  const m0 = await mktOf(mkt);
  ok(m0.fundingCfg === fundingCfg && m0.funding?.maxFund8hBps === 100 && m0.funding?.decaySlots === 1440, `market stores fundingCfg ${JSON.stringify(m0.funding)}`);

  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 5n * POS_SCALE })], [oL, oS]);
  const m1 = await mktOf(mkt);
  console.log(`opened Long5/Short5 @ $100; premiumE6 after trade = ${m1.premiumE6}`);

  // external funding injection must be rejected while built-in funding is on
  const r1 = await rejects([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 100n * POS_SCALE, fundingSign: 0, fundingE6: 1000n })], [oracle], 103);
  ok(r1 === "ok", `external fundE6 injection rejected (invalidParams) — ${r1}`);

  // let ~60s of slots pass, then push an UNCHANGED price -> built-in funding accrues
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 100n * POS_SCALE })], [oracle]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pL }), refreshLeg(P, { dex, market: mkt, portfolio: pS })]);
  const capL = await cap(pL), capS = await cap(pS), sA = (await mktOf(mkt)).lastOracleSlot;
  await sleep(60_000);
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 100n * POS_SCALE })], [oracle]);
  const sB = (await mktOf(mkt)).lastOracleSlot, dt = sB - sA;
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pL })]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pS })]);
  const dL = (await cap(pL)) - capL, dS = (await cap(pS)) - capS;
  // expected base funding (premium ~0 -> rate = +0.01%/8h, longs pay): qty * price * 100e-6 * dt / 72000
  const exp = Number(5n * 100n * POS_SCALE * 100n * dt / (1_000_000n * SLOTS_PER_8H));
  console.log(`dt=${dt} slots, price unchanged $100: long Δ=${dL} short Δ=${dS} (E6 units), expected ≈ -${exp}/+${exp}`);
  ok(dL < 0n && dS > 0n, "LONGS PAY base interest (+0.01%/8h) to shorts at zero premium");
  ok(dL + dS >= -2n && dL + dS <= 2n, `zero-sum within rounding (sum=${dL + dS})`);
  ok(Math.abs(Number(-dL) - exp) <= Math.max(3, exp * 0.35), `magnitude ≈ qty*price*0.01%*dt/72000 (got ${-dL}, exp ${exp})`);

  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  ok(d.vaultBalance === spl && spl === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards, "conservation V==SPL==C+I+R+S+Rew");
  console.log(`\n${pass} passed, ${fail.length} failed${fail.length ? "\nFAILURES:\n - " + fail.join("\n - ") : "\nBUILT-IN FUNDING WORKS"}`);
  process.exit(fail.length ? 1 : 0);
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
