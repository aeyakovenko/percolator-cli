/** MAINNET round-4 bounty (9b45ad1, fresh program ids): BTC/USD market, real USDC collateral, 2bps trade fee
 *  -> wSOL buy-and-burn reward module, BUILT-IN HL/Binance funding (+0.01%/8h base, ±0.05% deadband, ±1%/8h cap).
 *  ~$69 across 3 prizes (insurance / vault / user long). Pushed BTC oracle (operator-cranked, lazy).
 *  Prize portfolios are owned by the funder (id.json) so they are always recoverable.
 *  Writes lean-mainnet-r4.json + saves the oracle keypair BEFORE first use. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAccount, getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_MAINNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, REWARD_CFG_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, initPortfolio, depositCollateral, depositInsurance, trade, rewardInit, packFundingCfg,
  deriveDexVault, deriveRewAuth, parseDex, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_MAINNET.percolator, RM = LEAN_MAINNET.rewardModule;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const ORACLE_PATH = `${process.env.HOME}/.config/solana/lean-mainnet-r4-oracle.json`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { const m = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|rate|block height|timed out|not found/i.test(m)) { await sleep(2000 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp; }
const U = (n: bigint) => (Number(n) / 1e6).toFixed(4);

async function main() {
  if (fs.existsSync("lean-mainnet-r4.json")) throw new Error("lean-mainnet-r4.json already exists — refusing to create a second round-4 market");
  const r: any = await (await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot")).json();
  const init = BigInt(Math.round(parseFloat(r.data.amount) * 1e6));
  const fTok = await getAssociatedTokenAddress(USDC, funder.publicKey);
  const have = (await getAccount(conn, fTok)).amount;
  console.log(`BTC/USD init = $${U(init)}; funder USDC = $${U(have)}`);
  if (have < 94n * POS_SCALE) throw new Error(`need >= $94 USDC, have $${U(have)}`);

  const oracle = Keypair.generate();
  fs.writeFileSync(ORACLE_PATH, JSON.stringify(Array.from(oracle.secretKey)), { mode: 0o600 }); // persist BEFORE use

  const feeVault = await createAccount(conn, funder, USDC, funder.publicKey, Keypair.generate());
  const dex = (await newAcc(P, DEX_SIZE)).publicKey;
  await send([initDex(P, { dex, admin: funder.publicKey, mint: USDC, feeVault, decimals: 6, createFee: 0n, allowFreeze: 1 })]); // USDC has a freeze authority
  const V: VaultAccounts = { dex, mint: USDC, vault: deriveDexVault(P, dex)[0] };

  const cfg = await newAcc(RM, REWARD_CFG_SIZE);
  const [rewAuth] = deriveRewAuth(RM, cfg.publicKey);
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
  const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, fundingCfg,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n, rewardBps: 10000n, rewardRecipient: rewAuth };
  const mkt = (await newAcc(P, MARKET_SIZE)).publicKey;
  await send([createMarket(P, { dex, market: mkt, mint: USDC, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  const quoteVault = await createAccount(conn, funder, USDC, rewAuth, Keypair.generate());
  const targetEscrow = await createAccount(conn, funder, WSOL, rewAuth, Keypair.generate());
  const burnSink = await createAccount(conn, funder, WSOL, rewAuth, Keypair.generate());
  await send([rewardInit(RM, { cfg: cfg.publicKey, mktAdmin: funder.publicKey, percolator: P, dex, market: mkt, quoteMint: USDC, quoteVault, targetMint: WSOL, targetEscrow, burnSink, burnMode: 1, epochSlots: 32n, minBatchQuote: 1n * POS_SCALE, reserveRateE6: 1n * POS_SCALE })]);

  // PRIZE 1: insurance $23
  const rIns = (await newAcc(P, INS_RECEIPT_SIZE)).publicKey;
  await send([depositInsurance(P, V, { market: mkt, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  // PRIZE 2: vault portfolio $23 ; PRIZE 3: user long $23 vs funder-owned counterparty short $25
  const O = funder.publicKey;
  const pflV = (await newAcc(P, PORTFOLIO_SIZE)).publicKey, pflU = (await newAcc(P, PORTFOLIO_SIZE)).publicKey, pflC = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  for (const p of [pflV, pflU, pflC]) await send([initPortfolio(P, { dex, portfolio: p, owner: O })]);
  await send([depositCollateral(P, V, { portfolio: pflV, depositor: O, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pflU, depositor: O, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pflC, depositor: O, sourceToken: fTok, amount: 25n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pflU, longOwner: O, shortPortfolio: pflC, shortOwner: O, mode: TRADE_MODE.OPEN, qty: 3000n })]); // 0.003 BTC

  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const m = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  const r0 = await conn.getMultipleAccountsInfoAndContext([dex, V.vault], "confirmed");
  const dd = parseDex(Buffer.from(r0.value[0]!.data)), spl = Buffer.from(r0.value[1]!.data).readBigUInt64LE(64);
  const pu = parsePortfolio(Buffer.from((await conn.getAccountInfo(pflU))!.data));
  console.log(`\n=== MAINNET ROUND-4 BOUNTY (9b45ad1) ===`);
  console.log(`DEX ${dex.toBase58()}  MARKET(BTC/USD) ${mkt.toBase58()} mark=$${U(m.markPrice)} fee=${m.tradeFeeBps}bps funding=${JSON.stringify(m.funding)}`);
  console.log(`PRIZE1 insurance $${U(m.insurance)} | PRIZE2 vault ${pflV.toBase58()} | PRIZE3 long ${pflU.toBase58()} (${pu.legs[0] ? Number(pu.legs[0].rawBasis) / 1e6 : 0} BTC) | counterparty ${pflC.toBase58()}`);
  console.log(`conservation (same-slot): V==SPL==C+I+R+S+Rew ${dd.vaultBalance === spl && spl === dd.totalCapital + dd.totalInsurance + dd.totalResidual + dd.totalSurplus + dd.totalRewards} (V=$${U(d.vaultBalance)})`);
  fs.writeFileSync("lean-mainnet-r4.json", JSON.stringify({ commit: "9b45ad1", round: 4, percolator: P.toBase58(), rewardModule: RM.toBase58(),
    matcher: LEAN_MAINNET.matcher.toBase58(), oracleAdapter: LEAN_MAINNET.oracleAdapter.toBase58(), usdc: USDC.toBase58(),
    dex: dex.toBase58(), market: mkt.toBase58(), oracleAuth: oracle.publicKey.toBase58(), feeVault: feeVault.toBase58(),
    fundingCfg: { baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440, packed: fundingCfg.toString() },
    rewardCfg: cfg.publicKey.toBase58(), rewAuth: rewAuth.toBase58(), quoteVault: quoteVault.toBase58(), targetEscrow: targetEscrow.toBase58(), burnSink: burnSink.toBase58(),
    insReceipt: rIns.toBase58(), ownersKey: "funder/id.json", counterpartyShort: pflC.toBase58(),
    prizes: { insurance: mkt.toBase58(), vaultPortfolio: pflV.toBase58(), userLong: pflU.toBase58() } }, null, 2) + "\n");
  console.log(`manifest -> lean-mainnet-r4.json; oracle keypair -> ${ORACLE_PATH.replace(process.env.HOME!, "~")}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(String(e).slice(0, 600)); process.exit(1); });
