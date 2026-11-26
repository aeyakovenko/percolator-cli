/** End-to-end normal-case test (161ed3c devnet): all 3 bounty prizes behave + a full wSOL
 *  buy-and-burn reward epoch (StartEpoch -> SubmitBid -> SettleEpoch -> ClaimQuote). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo, createSyncNativeInstruction, NATIVE_MINT, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, REWARD_CFG_SIZE, EPOCH_SIZE, BIDDER_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, initPortfolio, depositCollateral, withdrawCollateral, depositInsurance, withdrawInsurance, trade, refreshLeg,
  rewardInit, rewardStartEpoch, rewardSubmitBid, rewardSettleEpoch, rewardClaimQuote,
  deriveDexVault, deriveRewAuth, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const RM = process.env.LEAN_REWARD ? new PublicKey(process.env.LEAN_REWARD) : LEAN_DEVNET.rewardModule;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp; }
const bal = async (t: PublicKey) => (await getAccount(conn, t)).amount;
const U = (n: bigint) => Number(n) / 1e6;
const mktOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data));
const pfOf = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data));
async function waitSlots(n: number) { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) < s + n) await sleep(500); }
const BTC = 95_000n * POS_SCALE;

async function main() {
  const USDC = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, USDC, fTok, funder, 100_000n * POS_SCALE);
  const dex = (await newAcc(P, DEX_SIZE)).publicKey;
  await send([initDex(P, { dex, admin: funder.publicKey, mint: USDC, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint: USDC, vault: deriveDexVault(P, dex)[0] };
  const cfg = await newAcc(RM, REWARD_CFG_SIZE);
  const [rewAuth] = deriveRewAuth(RM, cfg.publicKey);
  const oracle = Keypair.generate();
  // tradeFeeBps=100 (1%) for fast reward accrual in the E2E; rewardBps=10000 -> wSOL reward.
  const params: MarketParams = { initPrice: BTC, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 500n, liqFeeBps: 50n, tradeFeeBps: 100n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, rewardBps: 10000n, rewardRecipient: rewAuth };
  const mkt = (await newAcc(P, MARKET_SIZE)).publicKey;
  await send([createMarket(P, { dex, market: mkt, mint: USDC, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const quoteVault = await createAccount(conn, funder, USDC, rewAuth, Keypair.generate());
  const targetEscrow = await createAccount(conn, funder, NATIVE_MINT, rewAuth, Keypair.generate());
  const burnSink = await createAccount(conn, funder, NATIVE_MINT, rewAuth, Keypair.generate());
  await send([rewardInit(RM, { cfg: cfg.publicKey, mktAdmin: funder.publicKey, percolator: P, dex, market: mkt, quoteMint: USDC, quoteVault, targetMint: NATIVE_MINT, targetEscrow, burnSink, burnMode: 1, epochSlots: 32n, minBatchQuote: 1n * POS_SCALE, reserveRateE6: 1n * POS_SCALE })]);

  // --- prizes ---
  const rIns = (await newAcc(P, INS_RECEIPT_SIZE)).publicKey;
  await send([depositInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  const oV = Keypair.generate(); const pflV = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflV, owner: oV.publicKey })], [oV]);
  await send([depositCollateral(P, V, { portfolio: pflV, depositor: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  const oU = Keypair.generate(); const pflU = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  const oC = Keypair.generate(); const pflC = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflU, owner: oU.publicKey })], [oU]);
  await send([initPortfolio(P, { dex, portfolio: pflC, owner: oC.publicKey })], [oC]);
  await send([depositCollateral(P, V, { portfolio: pflU, depositor: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pflC, depositor: funder.publicKey, sourceToken: fTok, amount: 2_000n * POS_SCALE })]);
  // user long 0.002 BTC; big counterparty funds fee generation too
  await send([trade(P, { dex, market: mkt, longPortfolio: pflU, longOwner: oU.publicKey, shortPortfolio: pflC, shortOwner: oC.publicKey, mode: TRADE_MODE.OPEN, qty: 2000n })], [oU, oC], false);
  console.log("setup done: insurance $23, vault pfl $23, user long 0.002 BTC");

  // ===== PART A: all 3 prize pieces behave normally =====
  // 1. user long: close it -> capital realizes back (owner-signed)
  const uCap0 = (await pfOf(pflU)).capital;
  await send([trade(P, { dex, market: mkt, longPortfolio: pflU, longOwner: oU.publicKey, shortPortfolio: pflC, shortOwner: oC.publicKey, mode: TRADE_MODE.CLOSE, qty: 2000n })], [oU, oC], false);
  const u = await pfOf(pflU);
  ok(u.legs.length === 0, "PRIZE 3 user long closes cleanly (flat)");
  // withdraw user capital to owner's token account
  const uTok = await createAccount(conn, funder, USDC, oU.publicKey, Keypair.generate());
  await send([withdrawCollateral(P, V, { portfolio: pflU, owner: oU.publicKey, destToken: uTok, amount: (await pfOf(pflU)).capital })], [oU]);
  ok((await bal(uTok)) > 20_000000n && (await pfOf(pflU)).capital === 0n, `PRIZE 3 user withdrew ~$${U(await bal(uTok))} to own wallet (rest = trade fees -> reward)`);

  // 2. vault portfolio: owner withdraws the loose collateral
  const vTok = await createAccount(conn, funder, USDC, oV.publicKey, Keypair.generate());
  await send([withdrawCollateral(P, V, { portfolio: pflV, owner: oV.publicKey, destToken: vTok, amount: 23n * POS_SCALE })], [oV]);
  ok((await bal(vTok)) === 23n * POS_SCALE, "PRIZE 2 vault collateral withdrawn by owner ($23)");

  // 3. insurance: LP withdraws (burns shares) back to USDC
  const insTok = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  const m1 = await mktOf(mkt);
  await send([withdrawInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, destToken: insTok, burnShares: m1.totalInsShares })]);
  ok((await bal(insTok)) >= 22_000000n, `PRIZE 1 insurance withdrawn by LP (~$${U(await bal(insTok))})`);

  // ===== PART B: full wSOL buy-and-burn reward epoch =====
  const mAcc = await mktOf(mkt);
  console.log(`reward accrued so far = $${U(mAcc.rewardAccrued)} (from 1% fee on the opens/closes)`);
  ok(mAcc.rewardAccrued >= 1n * POS_SCALE, `reward accrued >= minBatch $1 (got $${U(mAcc.rewardAccrued)})`);

  const epoch = await newAcc(RM, EPOCH_SIZE);
  await send([rewardStartEpoch(RM, { cfg: cfg.publicKey, epochAcc: epoch.publicKey, dex, market: mkt, quoteMint: USDC, dexVault: V.vault, quoteVault, percolator: P })]);
  const qvPot = await bal(quoteVault);
  ok(qvPot >= 1n * POS_SCALE, `StartEpoch pulled $${U(qvPot)} USDC into the reward quoteVault`);

  // bidder wraps ~0.01 SOL and bids it
  const bidder = Keypair.generate();
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: bidder.publicKey, lamports: 30_000_000 })]);
  const bidderWsol = await createAccount(conn, funder, NATIVE_MINT, bidder.publicKey, Keypair.generate());
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: bidderWsol, lamports: 10_000_000 }), createSyncNativeInstruction(bidderWsol)]);
  const bidReceipt = await newAcc(RM, BIDDER_SIZE);
  const bidAmt = 5_000_000n; // 0.005 wSOL
  await send([rewardSubmitBid(RM, { cfg: cfg.publicKey, epochAcc: epoch.publicKey, bidReceipt: bidReceipt.publicKey, bidder: bidder.publicKey, bidderTargetTok: bidderWsol, targetEscrow, targetMint: NATIVE_MINT, amount: bidAmt })], [bidder]);
  ok((await bal(targetEscrow)) === bidAmt, `SubmitBid escrowed ${Number(bidAmt)/1e9} wSOL`);

  // wait for epoch to end, settle (burns the escrowed wSOL to the dead-sink), then bidder claims USDC
  await waitSlots(34);
  const sink0 = await bal(burnSink);
  await send([rewardSettleEpoch(RM, { cfg: cfg.publicKey, epochAcc: epoch.publicKey, targetEscrow, targetMint: NATIVE_MINT, burnSink, burnMode: 1 })]);
  ok((await bal(burnSink)) - sink0 === bidAmt, `SettleEpoch burned ${Number(bidAmt)/1e9} wSOL into the dead-sink`);

  const bidderUsdc = await createAccount(conn, funder, USDC, bidder.publicKey, Keypair.generate());
  await send([rewardClaimQuote(RM, { cfg: cfg.publicKey, epochAcc: epoch.publicKey, bidReceipt: bidReceipt.publicKey, bidder: bidder.publicKey, quoteVault, bidderQuoteTok: bidderUsdc, quoteMint: USDC })], [bidder]);
  const got = await bal(bidderUsdc);
  ok(got > 0n, `ClaimQuote: sole bidder received $${U(got)} USDC for their burned wSOL (buy-and-burn complete)`);

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("E2E OK: all 3 prizes behave normally, and the wSOL buy-and-burn reward epoch (start->bid->settle->claim) works end to end.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
