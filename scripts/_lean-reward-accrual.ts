/** ee69211 reward-accrual: a market with tradeFeeBps>0 + rewardBps>0 routes a share of trade fees
 *  into MktOff.rewardAccrued (F_m) and DexOff.totalRewards, disjoint from C/I/R/S, conserved. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, initPortfolio, depositCollateral, trade, deriveDexVault, deriveRewAuth,
  parseDex, parseMarket, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const RM = LEAN_DEVNET.rewardModule;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const U = (n: bigint) => Number(n) / 1e6;

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  // reward recipient = the rewm PDA for some cfg (accrual only stores it; claim is CPI-only)
  const fakeCfg = Keypair.generate().publicKey;
  const [rewAuth] = deriveRewAuth(RM, fakeCfg);
  const oracle = Keypair.generate();
  const params: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 100n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, rewardBps: 5000n, rewardRecipient: rewAuth };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const m0 = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  ok(m0.rewardBps === 5000n, `createMarket stored rewardBps=5000`);
  ok(m0.rewardRecipient.equals(rewAuth), `createMarket stored rewardRecipient = rewm PDA`);

  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 200n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 200n * POS_SCALE })]);
  // fee-generating trade: 5 units @ $100 = $500 notional, tradeFee 1% = $5, rewardBps 50% -> ~$2.5 reward
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 5n * POS_SCALE })], [oL, oS], false);

  const m1 = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  const d1 = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  console.log(`after fee trade: market.rewardAccrued=$${U(m1.rewardAccrued)} dex.totalRewards=$${U(d1.totalRewards)} feeSurplusInsFronted=$${U(m1.insFronted)}`);
  ok(m1.rewardAccrued > 0n, `trade fee accrued to market.rewardAccrued ($${U(m1.rewardAccrued)})`);
  ok(d1.totalRewards === m1.rewardAccrued, `dex.totalRewards == Σ market.rewardAccrued`);
  ok(d1.vaultBalance === spl, `V == SPL ($${U(d1.vaultBalance)})`);
  ok(d1.vaultBalance === d1.totalCapital + d1.totalInsurance + d1.totalResidual + d1.totalSurplus + d1.totalRewards,
     `conservation V == C+I+R+S+totalRewards (rewards disjoint)`);

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("REWARD ACCRUAL WORKS: trade fees route to rewardAccrued/totalRewards, disjoint & conserved.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
