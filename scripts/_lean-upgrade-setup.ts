/** DEVNET in-place upgrade proof, step 2: recreate the LIVE mainnet round-4 state on FRESH devnet program ids running
 *  the byte-exact mainnet 887ba02 binaries (mirrors scripts/lean-mainnet-r4-bounty.ts + lean-mainnet-r4-amm.ts), plus
 *  extra realistic state that must survive the upgrade:
 *   - MKT1 "BTC": exact mainnet params (built-in funding, 2 bps fee, rewardBps 10000 -> wSOL buy-and-burn reward module),
 *     $23 insurance receipt, $23 loose-collateral prize portfolio, 0.003 long vs counterparty short, PropAMM vault
 *     ($10 LP, half-spread 20 / impact 5 / maxFill 200, SetPortfolioMatcher) HOLDING INVENTORY (taker K left a long open);
 *   - MKT2: second market (built-in funding, rewardBps 0 => exercises the changed fee routing), used for MULTI-LEG
 *     portfolios: third party T and counterparty C2 hold a leg in MKT1 AND MKT2;
 *   - MKT3: sacrificial market with the mainnet config for the liquidation / deficit-mode scenario (two thin longs vs a whale);
 *   - accrued reward fees, accrued funding and un-refreshed legs with pending PnL (oracle pushed after the last refresh).
 *  Writes $OUT_DIR/manifest.json (same shape as lean-mainnet-r4.json + extras). Run ONCE, before the upgrade. */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";
import {
  DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, REWARD_CFG_SIZE, PROP_CTX_SIZE, POS_SCALE, TRADE_MODE, K_ZERO,
  initDex, createMarket, initPortfolio, depositCollateral, depositInsurance, trade, rewardInit, packFundingCfg, updateOracle,
  propAmmInit, setPortfolioMatcher, tradeWithMatcher, deriveDexVault, deriveRewAuth, clampPush,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";
import { conn, funder, guard, PROG, send, newAcc, namedKp, outKp, saveMani, MANI_PATH, snapshot, refreshOnly, coinbase, sleep, U, mkt, pfl, ok, fails, pass } from "./_lean-upgrade-lib.js";

const P = PROG.percolator, RM = PROG.rewardModule, M = PROG.matcher;

async function main() {
  await guard();
  if (fs.existsSync(MANI_PATH)) throw new Error(`${MANI_PATH} exists - refusing to create a second state`);
  const O = funder.publicKey;
  const init = await coinbase("BTC-USD");
  console.log(`BTC/USD init = $${U(init)}  percolator ${P.toBase58()}`);

  const mint = await createMint(conn, funder, O, null, 6);
  const fTok = await createAccount(conn, funder, mint, O, Keypair.generate());
  const MINTED = 100_000n * POS_SCALE;
  await mintTo(conn, funder, mint, fTok, funder, MINTED);
  const feeVault = await createAccount(conn, funder, mint, O, Keypair.generate());
  const dex = await newAcc(DEX_SIZE, P);
  await send([initDex(P, { dex, admin: O, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };

  // ---- MKT1: exact mainnet round-4 config
  const oracle = outKp("oracle"), oracle2 = outKp("oracle2"), oracle3 = outKp("oracle3");
  const cfg = await newAcc(REWARD_CFG_SIZE, RM);
  const [rewAuth] = deriveRewAuth(RM, cfg);
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
  const base = { exitWindow: 10n, maxStaleness: 9000n, fundingCfg, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const params: MarketParams = { ...base, initPrice: init, rewardBps: 10000n, rewardRecipient: rewAuth };
  const mkt1 = await newAcc(MARKET_SIZE, P);
  await send([createMarket(P, { dex, market: mkt1, mint, oracleAuth: oracle.publicKey, creator: O, creatorToken: fTok, feeVault, params })]);
  const quoteVault = await createAccount(conn, funder, mint, rewAuth, Keypair.generate());
  const targetEscrow = await createAccount(conn, funder, NATIVE_MINT, rewAuth, Keypair.generate());
  const burnSink = await createAccount(conn, funder, NATIVE_MINT, rewAuth, Keypair.generate());
  await send([rewardInit(RM, { cfg, mktAdmin: O, percolator: P, dex, market: mkt1, quoteMint: mint, quoteVault, targetMint: NATIVE_MINT, targetEscrow, burnSink, burnMode: 1, epochSlots: 32n, minBatchQuote: 1n * POS_SCALE, reserveRateE6: 1n * POS_SCALE })]);
  // ---- MKT2 (funding on, rewardBps 0) and MKT3 (mainnet config; reward recipient = a plain key)
  const mkt2 = await newAcc(MARKET_SIZE, P);
  await send([createMarket(P, { dex, market: mkt2, mint, oracleAuth: oracle2.publicKey, creator: O, creatorToken: fTok, feeVault, params: { ...base, initPrice: 150n * POS_SCALE } })]);
  const rew3 = namedKp("rew3");
  const mkt3 = await newAcc(MARKET_SIZE, P);
  await send([createMarket(P, { dex, market: mkt3, mint, oracleAuth: oracle3.publicKey, creator: O, creatorToken: fTok, feeVault, params: { ...base, initPrice: 100n * POS_SCALE, rewardBps: 10000n, rewardRecipient: rew3.publicKey } })]);

  // ---- prizes (as on mainnet: all owned by the funder)
  const insReceipt = await newAcc(INS_RECEIPT_SIZE, P);
  await send([depositInsurance(P, V, { market: mkt1, receipt: insReceipt, lp: O, sourceToken: fTok, amount: 23n * POS_SCALE })]);
  const mkPfl = async (owner: Keypair, usd6: bigint) => {
    const k = await newAcc(PORTFOLIO_SIZE, P);
    await send([initPortfolio(P, { dex, portfolio: k, owner: owner.publicKey })], [owner]);
    if (usd6 > 0n) await send([depositCollateral(P, V, { portfolio: k, depositor: O, sourceToken: fTok, amount: usd6 })]);
    return k;
  };
  const pflV = await mkPfl(funder, 23n * POS_SCALE), pflU = await mkPfl(funder, 23n * POS_SCALE), pflC = await mkPfl(funder, 25n * POS_SCALE);
  await send([trade(P, { dex, market: mkt1, longPortfolio: pflU, longOwner: O, shortPortfolio: pflC, shortOwner: O, mode: TRADE_MODE.OPEN, qty: 3000n })]);

  // ---- PropAMM vault (mainnet r4-amm, LP $10)
  const lpp = await mkPfl(funder, 10n * POS_SCALE);
  const ctxKp = Keypair.generate();
  const m1 = await mkt(mkt1);
  {
    const lam = await conn.getMinimumBalanceForRentExemption(PROP_CTX_SIZE);
    const { SystemProgram } = await import("@solana/web3.js");
    await send([SystemProgram.createAccount({ fromPubkey: O, newAccountPubkey: ctxKp.publicKey, lamports: lam, space: PROP_CTX_SIZE, programId: M }),
      propAmmInit(M, { ctx: ctxKp.publicKey, owner: O, allowedMarketIds: [m1.marketId], halfSpreadBps: 20n, impactBps: 5n, maxFillQty: 200n })], [ctxKp]);
  }
  const ctx = ctxKp.publicKey;
  await send([setPortfolioMatcher(P, { portfolio: lpp, owner: O, matcherCtx: ctx })]);

  // ---- extra realistic state
  const tp = namedKp("tp"), cp2 = namedKp("cp2"), takerK = namedKp("takerK"), vicA = namedKp("vicA"), vicB = namedKp("vicB"), whale = namedKp("whale");
  const pflT = await mkPfl(tp, 500n * POS_SCALE), pflC2 = await mkPfl(cp2, 500n * POS_SCALE);
  // third party: 0.04 BTC long on MKT1 (accrues ~$1 of reward fees) + 1.0 long on MKT2 => MULTI-LEG (and so is its counterparty)
  await send([trade(P, { dex, market: mkt1, longPortfolio: pflT, longOwner: tp.publicKey, shortPortfolio: pflC2, shortOwner: cp2.publicKey, mode: TRADE_MODE.OPEN, qty: 40_000n })], [tp, cp2]);
  await send([...await refreshOnly(P, dex, [pflT, pflC2]), trade(P, { dex, market: mkt2, longPortfolio: pflT, longOwner: tp.publicKey, shortPortfolio: pflC2, shortOwner: cp2.publicKey, mode: TRADE_MODE.OPEN, qty: 1_000_000n })], [tp, cp2]);
  // taker K leaves a 0.0001 long open against the AMM vault => the vault HOLDS INVENTORY (short 100) across the upgrade
  const pflK = await mkPfl(takerK, 5n * POS_SCALE);
  await send([tradeWithMatcher(P, { dex, takerPortfolio: pflK, taker: takerK.publicKey, lpPortfolio: lpp, matcherProgram: M, matcherCtx: ctx,
    legs: [{ market: mkt1, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: 100n, limitPrice: m1.markPrice + m1.markPrice / 50n }] })], [takerK]);
  // sacrificial MKT3: two thin longs (1.0 @ $100, $10.10 each = IM + fee) vs a whale short 2.0
  const pflA = await mkPfl(vicA, 10_100_000n), pflB = await mkPfl(vicB, 10_100_000n), pflW = await mkPfl(whale, 500n * POS_SCALE);
  await send([trade(P, { dex, market: mkt3, longPortfolio: pflA, longOwner: vicA.publicKey, shortPortfolio: pflW, shortOwner: whale.publicKey, mode: TRADE_MODE.OPEN, qty: 1_000_000n })], [vicA, whale]);
  await send([...await refreshOnly(P, dex, [pflW]), trade(P, { dex, market: mkt3, longPortfolio: pflB, longOwner: vicB.publicKey, shortPortfolio: pflW, shortOwner: whale.publicKey, mode: TRADE_MODE.OPEN, qty: 1_000_000n })], [vicB, whale]);

  const mani: any = {
    commit: "887ba02", round: "upgrade-proof", cluster: "devnet", percolator: P.toBase58(), rewardModule: RM.toBase58(), matcher: M.toBase58(), oracleAdapter: PROG.oracleAdapter.toBase58(),
    initPrice: init.toString(), usdc: mint.toBase58(), funderToken: fTok.toBase58(), minted: MINTED.toString(), dex: dex.toBase58(), market: mkt1.toBase58(), oracleAuth: oracle.publicKey.toBase58(), feeVault: feeVault.toBase58(),
    fundingCfg: { baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440, packed: fundingCfg.toString() },
    rewardCfg: cfg.toBase58(), rewAuth: rewAuth.toBase58(), quoteVault: quoteVault.toBase58(), targetEscrow: targetEscrow.toBase58(), burnSink: burnSink.toBase58(),
    insReceipt: insReceipt.toBase58(), ownersKey: "funder/id.json", counterpartyShort: pflC.toBase58(),
    prizes: { insurance: mkt1.toBase58(), vaultPortfolio: pflV.toBase58(), userLong: pflU.toBase58() },
    ammVault: { kind: "PropAMM", matcherProgram: M.toBase58(), ctx: ctx.toBase58(), lpPortfolio: lpp.toBase58(), ownerKey: "funder/id.json", halfSpreadBps: 20, impactBps: 5, maxFillQty: "200", lpCapitalUsd: 10, allowedMarketIds: [m1.marketId.toString()] },
    extra: {
      market2: mkt2.toBase58(), market3: mkt3.toBase58(), rew3: rew3.publicKey.toBase58(),
      thirdParty: pflT.toBase58(), counterparty2: pflC2.toBase58(), takerK: pflK.toBase58(),
      victimA: pflA.toBase58(), victimB: pflB.toBase58(), whale: pflW.toBase58(),
    },
  };
  saveMani(mani);

  // ---- accrue funding + leave pending PnL on UNREFRESHED legs: push each oracle a few times after the last trade
  let p2 = 150n * POS_SCALE, p3 = 100n * POS_SCALE;
  for (let i = 0; i < 5; i++) {
    await sleep(6000);
    const a = await mkt(mkt1); const slot = BigInt(await conn.getSlot("confirmed"));
    const tgt = a.markPrice + a.markPrice / 2500n; // +0.04% per push (longs win)
    await send([updateOracle(P, { market: mkt1, oracleAuth: oracle.publicKey, price: clampPush(a.markPrice, tgt, a.maxMoveBps, slot - a.lastOracleSlot) })], [oracle]);
    p2 += p2 / 400n; await send([updateOracle(P, { market: mkt2, oracleAuth: oracle2.publicKey, price: p2 })], [oracle2]);
    if (i === 0) { p3 -= p3 / 250n; await send([updateOracle(P, { market: mkt3, oracleAuth: oracle3.publicKey, price: p3 })], [oracle3]); }
  }
  const s = await snapshot(P, dex, V.vault);
  const a = s.markets.get(mkt1.toBase58())!;
  console.log(`MKT1 mark $${U(a.markPrice)} kLong-K0=${a.kLong - K_ZERO} kShort-K0=${a.kShort - K_ZERO} (funding accrued, longs pay: ${(a.markPrice - init) - (a.kLong - K_ZERO)} E6 per 1.0 base) premiumE6=${a.premiumE6} rewardAccrued $${U(a.rewardAccrued)} insurance $${U(a.insurance)}`);
  ok(s.conserved && s.inv.ok, `setup conservation V==SPL==C+I+R+S+Rew @slot ${s.slot} (V=$${U(s.dex.vaultBalance)}) ${s.inv.problems.join("; ")}`);
  ok(a.insurance === 23n * POS_SCALE && (await pfl(pflV)).capital === 23n * POS_SCALE, "prizes: insurance $23, vault portfolio $23");
  ok(a.rewardAccrued > 0n, `accrued reward fees $${U(a.rewardAccrued)}`);
  ok((await pfl(lpp)).legs.some((l) => l.rawBasis === 100n), "AMM vault holds inventory (100)");
  ok((await pfl(pflT)).legs.filter((l) => l.rawBasis > 0n).length === 2, "third party is multi-leg (MKT1 + MKT2)");
  console.log(`manifest -> ${MANI_PATH}\nSETUP: ${pass} ok, ${fails.length} failed`);
  if (fails.length) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", String(e).replace(/api-key=[^ "&]*/g, "api-key=***").slice(0, 900)); process.exit(1); });
