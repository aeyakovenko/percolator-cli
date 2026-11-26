/** Round-3 bounty on devnet (161ed3c): BTC/USD market, USDC collateral, 2bps trade fee -> wSOL
 *  buy-and-burn reward module. Three ~$23 prize surfaces (total ~$69): insurance, a loose-collateral
 *  "vault" portfolio, and a user long position. Prints every address. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, REWARD_CFG_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, initPortfolio, depositCollateral, depositInsurance, trade, rewardInit,
  deriveDexVault, deriveRewAuth, parseDex, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const RM = LEAN_DEVNET.rewardModule;
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp; }
const U = (n: bigint) => Number(n) / 1e6;
const BTC = 95_000n * POS_SCALE; // $95,000

async function main() {
  console.log(`== round-3 bounty on devnet (percolator ${P.toBase58().slice(0,8)}…, reward ${RM.toBase58().slice(0,8)}…) ==`);
  const USDC = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, USDC, fTok, funder, 1_000n * POS_SCALE);

  const dex = (await newAcc(P, DEX_SIZE)).publicKey;
  await send([initDex(P, { dex, admin: funder.publicKey, mint: USDC, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint: USDC, vault: deriveDexVault(P, dex)[0] };

  const cfg = await newAcc(RM, REWARD_CFG_SIZE);
  const [rewAuth] = deriveRewAuth(RM, cfg.publicKey);

  const oracle = Keypair.generate();
  const params: MarketParams = { initPrice: BTC, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 500n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, rewardBps: 10000n, rewardRecipient: rewAuth };
  const mkt = (await newAcc(P, MARKET_SIZE)).publicKey;
  await send([createMarket(P, { dex, market: mkt, mint: USDC, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  const quoteVault = await createAccount(conn, funder, USDC, rewAuth, Keypair.generate());
  const targetEscrow = await createAccount(conn, funder, WSOL, rewAuth, Keypair.generate());
  const burnSink = await createAccount(conn, funder, WSOL, rewAuth, Keypair.generate());
  await send([rewardInit(RM, { cfg: cfg.publicKey, mktAdmin: funder.publicKey, percolator: P, dex, market: mkt,
    quoteMint: USDC, quoteVault, targetMint: WSOL, targetEscrow, burnSink, burnMode: 1,
    epochSlots: 32n, minBatchQuote: 1n * POS_SCALE, reserveRateE6: 1n * POS_SCALE })]);

  // PRIZE 1: insurance ~$23
  const rIns = (await newAcc(P, INS_RECEIPT_SIZE)).publicKey;
  await send([depositInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);

  // PRIZE 2: loose-collateral "vault" portfolio ~$23 (no position)
  const oVault = Keypair.generate(); const pflVault = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflVault, owner: oVault.publicKey })], [oVault]);
  await send([depositCollateral(P, V, { portfolio: pflVault, depositor: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);

  // PRIZE 3: user LONG ~$23 collateral (vs operator-funded counterparty short)
  const oUser = Keypair.generate(); const pflUser = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  const oCp = Keypair.generate(); const pflCp = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflUser, owner: oUser.publicKey })], [oUser]);
  await send([initPortfolio(P, { dex, portfolio: pflCp, owner: oCp.publicKey })], [oCp]);
  await send([depositCollateral(P, V, { portfolio: pflUser, depositor: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pflCp, depositor: funder.publicKey, sourceToken: fTok, amount: 40n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pflUser, longOwner: oUser.publicKey, shortPortfolio: pflCp, shortOwner: oCp.publicKey, mode: TRADE_MODE.OPEN, qty: 2000n })], [oUser, oCp], false);

  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const m = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  const pu = parsePortfolio(Buffer.from((await conn.getAccountInfo(pflUser))!.data));
  const pv = parsePortfolio(Buffer.from((await conn.getAccountInfo(pflVault))!.data));
  console.log(`\n=== ROUND-3 BOUNTY (devnet) ===`);
  console.log(`DEX            ${dex.toBase58()}  (USDC ${USDC.toBase58()})`);
  console.log(`MARKET BTC/USD ${mkt.toBase58()}  mark=$${U(m.markPrice)} tradeFeeBps=${m.tradeFeeBps} rewardBps=${m.rewardBps}`);
  console.log(`  oracleAuth   ${oracle.publicKey.toBase58()} (operator-cranked)`);
  console.log(`REWARD cfg     ${cfg.publicKey.toBase58()}  rewAuthPDA ${rewAuth.toBase58()} (wSOL buy&burn, dead-sink)`);
  console.log(`  quoteVault ${quoteVault.toBase58()}  targetEscrow ${targetEscrow.toBase58()}  burnSink ${burnSink.toBase58()}`);
  console.log(`PRIZE 1 insurance = $${U(m.insurance)}   (market.insurance)`);
  console.log(`PRIZE 2 vault pfl = $${U(pv.capital)}   ${pflVault.toBase58()}`);
  console.log(`PRIZE 3 user long = $${U(pu.capital)} capital, leg ${pu.legs[0]?.sideName} rawBasis ${pu.legs[0] ? Number(pu.legs[0].rawBasis)/1e6 : 0} BTC   ${pflUser.toBase58()}`);
  console.log(`conservation V==SPL==C+I+R+S+Rew: ${d.vaultBalance === spl && d.vaultBalance === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards}`);
  console.log(`total prize pool ~= $${U(m.insurance) + U(pv.capital) + U(pu.capital)} (insurance + vault + user long)`);
  fs.writeFileSync("lean-round3-devnet.json", JSON.stringify({ commit: "161ed3c", percolator: P.toBase58(), rewardModule: RM.toBase58(),
    usdc: USDC.toBase58(), dex: dex.toBase58(), market: mkt.toBase58(), oracleAuth: oracle.publicKey.toBase58(),
    rewardCfg: cfg.publicKey.toBase58(), rewAuth: rewAuth.toBase58(), quoteVault: quoteVault.toBase58(), targetEscrow: targetEscrow.toBase58(), burnSink: burnSink.toBase58(),
    prizes: { insurance: mkt.toBase58(), vaultPortfolio: pflVault.toBase58(), userLong: pflUser.toBase58() } }, null, 2));
  console.log(`\nmanifest -> lean-round3-devnet.json`);
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
