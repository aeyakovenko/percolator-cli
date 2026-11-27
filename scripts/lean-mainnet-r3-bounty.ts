/** MAINNET round-3 bounty (161ed3c, new addresses): BTC/USD market, real USDC collateral, 2bps
 *  trade fee -> wSOL buy-and-burn reward module. ~$69 across 3 prizes (insurance / vault / user long).
 *  Pushed BTC oracle (operator-cranked, lazy). Writes lean-mainnet-r3.json + saves the oracle keypair. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAccount, getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_MAINNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, REWARD_CFG_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, initPortfolio, depositCollateral, depositInsurance, trade, rewardInit,
  deriveDexVault, deriveRewAuth, parseDex, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_MAINNET.percolator;
const RM = LEAN_MAINNET.rewardModule;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { const m = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|rate|block height|timed out|not found/i.test(m)) { await sleep(2000 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp; }
const U = (n: bigint) => Number(n) / 1e6;

async function btcPrice(): Promise<bigint> {
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const j: any = await r.json();
  const px = Math.round(parseFloat(j.data.amount) * 1e6);
  return BigInt(px);
}

async function main() {
  const init = await btcPrice();
  console.log(`BTC/USD init = $${U(init)}`);
  const fTok = await getAssociatedTokenAddress(USDC, funder.publicKey);
  const have = (await getAccount(conn, fTok)).amount;
  console.log(`funder USDC ${fTok.toBase58()} = $${U(have)}`);
  if (have < 95n * POS_SCALE) throw new Error(`need >= $95 USDC, have $${U(have)}`);

  const feeVault = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  const dex = (await newAcc(P, DEX_SIZE)).publicKey;
  await send([initDex(P, { dex, admin: funder.publicKey, mint: USDC, feeVault, decimals: 6, createFee: 0n, allowFreeze: 1 })]); // USDC has a freeze authority
  const V: VaultAccounts = { dex, mint: USDC, vault: deriveDexVault(P, dex)[0] };

  const cfg = await newAcc(RM, REWARD_CFG_SIZE);
  const [rewAuth] = deriveRewAuth(RM, cfg.publicKey);
  const oracle = Keypair.generate();
  fs.writeFileSync(`${process.env.HOME}/.config/solana/lean-mainnet-r3-oracle.json`, JSON.stringify(Array.from(oracle.secretKey)));

  const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, rewardBps: 10000n, rewardRecipient: rewAuth };
  const mkt = (await newAcc(P, MARKET_SIZE)).publicKey;
  await send([createMarket(P, { dex, market: mkt, mint: USDC, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  const quoteVault = await createAccount(conn, funder, USDC, rewAuth, Keypair.generate());
  const targetEscrow = await createAccount(conn, funder, WSOL, rewAuth, Keypair.generate());
  const burnSink = await createAccount(conn, funder, WSOL, rewAuth, Keypair.generate());
  await send([rewardInit(RM, { cfg: cfg.publicKey, mktAdmin: funder.publicKey, percolator: P, dex, market: mkt, quoteMint: USDC, quoteVault, targetMint: WSOL, targetEscrow, burnSink, burnMode: 1, epochSlots: 32n, minBatchQuote: 1n * POS_SCALE, reserveRateE6: 1n * POS_SCALE })]);

  // PRIZE 1 insurance $23
  const rIns = (await newAcc(P, INS_RECEIPT_SIZE)).publicKey;
  await send([depositInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  // PRIZE 2 vault portfolio $23
  const oV = Keypair.generate(); const pflV = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflV, owner: oV.publicKey })], [oV]);
  await send([depositCollateral(P, V, { portfolio: pflV, depositor: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  // PRIZE 3 user long $23 (vs operator counterparty short, ~$25)
  const oU = Keypair.generate(); const pflU = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  const oC = Keypair.generate(); const pflC = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: pflU, owner: oU.publicKey })], [oU]);
  await send([initPortfolio(P, { dex, portfolio: pflC, owner: oC.publicKey })], [oC]);
  await send([depositCollateral(P, V, { portfolio: pflU, depositor: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pflC, depositor: funder.publicKey, sourceToken: fTok, amount: 25n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pflU, longOwner: oU.publicKey, shortPortfolio: pflC, shortOwner: oC.publicKey, mode: TRADE_MODE.OPEN, qty: 3000n })], [oU, oC], false); // 0.003 BTC

  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const m = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  const pu = parsePortfolio(Buffer.from((await conn.getAccountInfo(pflU))!.data));
  const pv = parsePortfolio(Buffer.from((await conn.getAccountInfo(pflV))!.data));
  console.log(`\n=== MAINNET ROUND-3 BOUNTY (161ed3c) ===`);
  console.log(`percolator ${P.toBase58()}  reward ${RM.toBase58()}`);
  console.log(`DEX ${dex.toBase58()}  MARKET(BTC/USD) ${mkt.toBase58()} mark=$${U(m.markPrice)} fee=${m.tradeFeeBps}bps rewardBps=${m.rewardBps}`);
  console.log(`oracleAuth ${oracle.publicKey.toBase58()} (operator-cranked, lazy)`);
  console.log(`reward cfg ${cfg.publicKey.toBase58()} rewAuth ${rewAuth.toBase58()} (wSOL dead-sink); quoteVault ${quoteVault.toBase58()} burnSink ${burnSink.toBase58()}`);
  console.log(`PRIZE1 insurance $${U(m.insurance)} | PRIZE2 vault pfl $${U(pv.capital)} ${pflV.toBase58()} | PRIZE3 user long $${U(pu.capital)} (${pu.legs[0] ? Number(pu.legs[0].rawBasis)/1e6 : 0} BTC) ${pflU.toBase58()}`);
  console.log(`conservation V==SPL==C+I+R+S+Rew: ${d.vaultBalance === spl && d.vaultBalance === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards}`);
  fs.writeFileSync("lean-mainnet-r3.json", JSON.stringify({ commit: "161ed3c", percolator: P.toBase58(), rewardModule: RM.toBase58(), usdc: USDC.toBase58(),
    dex: dex.toBase58(), market: mkt.toBase58(), oracleAuth: oracle.publicKey.toBase58(), feeVault: feeVault.toBase58(),
    rewardCfg: cfg.publicKey.toBase58(), rewAuth: rewAuth.toBase58(), quoteVault: quoteVault.toBase58(), targetEscrow: targetEscrow.toBase58(), burnSink: burnSink.toBase58(),
    prizes: { insurance: mkt.toBase58(), vaultPortfolio: pflV.toBase58(), userLong: pflU.toBase58() } }, null, 2));
  console.log(`\nmanifest -> lean-mainnet-r3.json; oracle keypair -> ~/.config/solana/lean-mainnet-r3-oracle.json`);
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
