/** Round-3 prep rehearsal on devnet (a056eee): proves the new ABI + the USDC-freeze opt-in +
 *  the tighter margin bounds + core trade/PnL/insurance/conservation all work on the fixed build. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, depositInsurance, trade, refreshLeg,
  deriveDexVault, parseDex, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function expectFail(ixs: TransactionInstruction[], s: Keypair[], label: string) { try { await send(ixs, s); ok(false, `${label} (should have FAILED but succeeded)`); } catch { ok(true, label); } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const cap = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data)).capital;
async function waitSlot() { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) <= s) await sleep(300); }
async function conserved(dex: PublicKey, V: VaultAccounts) { const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data)); const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount); return d.vaultBalance === spl && d.vaultBalance === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus; }

// a056eee margin bound: maxMove<=2500, 4*maxMove+(maxMove^2+999)/1000+liqFee<=mm, mm+maxMove<=im
function params(): MarketParams {
  return { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, maxFrontBps: 0n };
}

async function main() {
  console.log(`== round-3 rehearsal on ${P.toBase58().slice(0,8)}… (a056eee) ==`);
  // Mint WITH a freeze authority (the real-USDC case) to exercise allowFreeze.
  const freezeAuth = Keypair.generate().publicKey;
  const mint = await createMint(conn, funder, funder.publicKey, freezeAuth, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);

  // 1. InitDex allowFreeze=0 must REJECT a freeze-authority mint (the hardening).
  const dexBad = await newAcc(P, DEX_SIZE);
  await expectFail([initDex(P, { dex: dexBad, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n, allowFreeze: 0 })], [], "InitDex allowFreeze=0 REJECTS a freeze-authority mint");

  // 2. InitDex allowFreeze=1 ACCEPTS it (real USDC can now seed a DEX).
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n, allowFreeze: 1 })]);
  ok(parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data)).allowFreeze === 1, "InitDex allowFreeze=1 ACCEPTS a freeze-authority mint (real USDC usable)");
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };

  // 3. createMarket: old loose params must now be REJECTED by the tighter bound; valid params accepted.
  const oracle = Keypair.generate();
  const mBad = await newAcc(P, MARKET_SIZE);
  await expectFail([createMarket(P, { dex, market: mBad, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: { ...params(), maxMoveBps: 400n } })], [], "createMarket REJECTS maxMoveBps=400 (violates 4*mm+…+liqFee<=mmBps)");
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: params() })]);
  ok(parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data)).status === 0, "createMarket ACCEPTS valid a056eee params");

  // 4. Seed insurance (the bounty prize) + verify.
  const rIns = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 70n * POS_SCALE })]);
  ok(parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data)).insurance === 70n * POS_SCALE, "seed insurance = 70 (prize)");

  // 5. Core trade + directional PnL + conservation (longs profit when price rises).
  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 5n * POS_SCALE })], [oL, oS], false);
  const capL0 = await cap(pL), capS0 = await cap(pS);
  await waitSlot();
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 101n * POS_SCALE })], [oracle]); // +1% (within maxMove 1%)
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pS })]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pL })]);
  const dL = Number((await cap(pL)) - capL0) / 1e6, dS = Number(capS0 - (await cap(pS))) / 1e6;
  ok(Math.abs(dL - 5) <= 0.5, `LONG profits +$5 on +1% (qty5*$1) — got +$${dL}`);
  ok(Math.abs(dS - 5) <= 0.5, `SHORT loses matching -$5 — got -$${dS}`);
  ok(await conserved(dex, V), "conservation V==SPL==C+I+R+S");

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("ROUND-3 CORE READY on a056eee: USDC-freeze opt-in works, tighter margin bounds enforced, trade/PnL/insurance/conservation all correct.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
