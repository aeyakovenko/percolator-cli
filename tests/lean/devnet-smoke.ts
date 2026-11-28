/**
 * Devnet smoke for the percolator-lean v2 TS client (src/lean, pinned to `2dc4d21`).
 *
 * Exercises EVERY encoder against the deployed devnet programs — all 20 percolator ops,
 * PropAMM matcher ops 0-1 + core SetPortfolioMatcher/TradeWithMatcher, oracle_adapter ops 0-1 — through a full market lifecycle, plus the
 * parsers, discovery, withLegRefresh bundler and checkDexInvariants. Success paths are
 * really sent; expected rejections are simulated and asserted against the SPECIFIC
 * custom error code.
 *
 *   pnpm test:lean                     (SOLANA_RPC_URL defaults to public devnet)
 *
 * Refuses to run against anything but devnet (genesis-hash check). Spends ~0.1 devnet SOL.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, PROP_CTX_SIZE,
  ADAPTER_CFG_SIZE, MAGIC, POS_SCALE, STATUS, SIDE, TRADE_MODE, FEED_TYPE, leanErrorName,
  assertDevnet, deriveDexVault, deriveOracleAuth,
  initDex, updateCreateFee, createMarket, transferMarketAdmin, burnMarketAdmin, rotateOracleAuth,
  updateOracle, initPortfolio, depositCollateral, withdrawCollateral, depositInsurance,
  withdrawInsurance, refreshLeg, trade, liquidate, clearDeadLeg, startWindDown, forceClosePair,
  resolveMarket, claimResolved, tombstoneMarket, closeAccount,
  propAmmInit, propAmmUpdate, setPortfolioMatcher, tradeWithMatcher, adapterInit, adapterCrank,
  parseDex, parseMarket, parsePortfolio, parseInsReceipt, parsePropAmmCtx, parseAdapterConfig,
  openLegs, withLegRefresh, realizeFlatLegs, snapshotDex, checkDexInvariants, discoverPortfolios, discoverMarkets,
  type MarketParams, type VaultAccounts,
} from "../../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const P = LEAN_DEVNET.percolator;
const M = LEAN_DEVNET.matcher;
const O = LEAN_DEVNET.oracleAdapter;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));

// ---------------------------------------------------------------- harness
let passed = 0;
const failures: string[] = [];
const covered = new Set<string>();
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[] = [], refresh = false) {
  let list = ixs;
  if (refresh) list = (await withLegRefresh(conn, ixs)).instructions;
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(...list);
      const sig = await sendAndConfirmTransaction(conn, tx, [funder, ...signers], { commitment: "confirmed" });
      covered.add(label);
      return sig;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (attempt < 2 && /block height exceeded|Blockhash not found|timed out/i.test(msg)) continue;
      throw new Error(`${label}: ${msg}`);
    }
  }
}

/** Simulate and assert a specific custom error code at a specific instruction index (default: last). */
async function expectErr(label: string, ixs: TransactionInstruction[], signers: Keypair[], code: number | number[], refresh = false) {
  const codes = Array.isArray(code) ? code : [code];
  let list = ixs;
  if (refresh) list = (await withLegRefresh(conn, ixs)).instructions;
  const tx = new Transaction().add(...list);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(funder, ...signers);
  const sim = await conn.simulateTransaction(tx);
  const err = sim.value.err as any;
  const got = err?.InstructionError?.[1]?.Custom;
  const idx = err?.InstructionError?.[0];
  const want = list.length - 1;
  ok(codes.includes(got) && idx === want,
    `${label} rejected with ${codes.map(leanErrorName).join("|")} [got ${got === undefined ? JSON.stringify(err) : `${leanErrorName(got)} at ix ${idx}`}]`);
  covered.add(label);
}

async function newProgramAccount(owner: PublicKey, size: number): Promise<Keypair> {
  const kp = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(size);
  await send("system.createAccount", [SystemProgram.createAccount({
    fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports, space: size, programId: owner,
  })], [kp]);
  return kp;
}
const acct = async (k: PublicKey) => Buffer.from((await conn.getAccountInfo(k, "confirmed"))!.data);
const tokBal = async (k: PublicKey) => (await getAccount(conn, k, "confirmed")).amount;
async function waitSlots(n: number) {
  const start = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) < start + n) await sleep(400);
}
async function invariants(label: string, dex: PublicKey) {
  const s = await snapshotDex(conn, P, dex);
  const rep = checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map((m) => m.data), s.portfolios.map((p) => p.data));
  ok(rep.ok, `${label}: DEX invariants hold (${s.markets.length} markets, ${s.portfolios.length} portfolios)${rep.ok ? "" : " — " + rep.problems.join("; ")}`);
}

// ---------------------------------------------------------------- run
async function main() {
  await assertDevnet(conn);
  console.log(`lean devnet smoke — percolator ${P.toBase58()} via ${RPC}`);
  const solStart = await conn.getBalance(funder.publicKey);

  const traderA = Keypair.generate();
  const traderB = Keypair.generate();
  const oracle1 = Keypair.generate();
  const oracle2 = Keypair.generate();
  const admin2 = Keypair.generate();
  // traders only sign; funder pays. admin2 needs no SOL either.

  // ---- tokens
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const funderTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const aTok = await createAccount(conn, funder, mint, traderA.publicKey, Keypair.generate());
  const bTok = await createAccount(conn, funder, mint, traderB.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, funderTok, funder, 10_000n * POS_SCALE);
  await mintTo(conn, funder, mint, aTok, funder, 1_000n * POS_SCALE);
  await mintTo(conn, funder, mint, bTok, funder, 5_000n * POS_SCALE);

  // ---- T1 InitDex + UpdateCreateFee
  console.log("T1 InitDex / UpdateCreateFee");
  const dexKp = await newProgramAccount(P, DEX_SIZE);
  const dex = dexKp.publicKey;
  const [vault] = deriveDexVault(P, dex);
  {
    // At 2dc4d21 InitDex has no explicit PDA check: the runtime rejects the signed
    // allocate/assign CPI when the bump is wrong, so this aborts without a custom code.
    const bad = initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: POS_SCALE, vault, vaultBump: (deriveDexVault(P, dex)[1] + 255) % 256 });
    const tx = new Transaction().add(bad);
    tx.feePayer = funder.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(funder);
    const err = (await conn.simulateTransaction(tx)).value.err as any;
    ok(err?.InstructionError?.[0] === 0, `InitDex wrong bump rejected by runtime PDA-signer check [${JSON.stringify(err?.InstructionError?.[1])}]`);
    covered.add("InitDex wrong bump");
  }
  await send("InitDex", [initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: POS_SCALE })]);
  const d0 = parseDex(await acct(dex));
  ok(d0.vault.equals(vault) && d0.quoteMint.equals(mint) && d0.createFee === POS_SCALE, "parseDex: vault/mint/createFee");
  await send("UpdateCreateFee", [updateCreateFee(P, { dex, admin: funder.publicKey, newFee: 2n * POS_SCALE, newAdmin: funder.publicKey })]);
  ok(parseDex(await acct(dex)).createFee === 2n * POS_SCALE, "UpdateCreateFee applied");
  const V: VaultAccounts = { dex, mint, vault };

  // ---- T2 CreateMarket ×2 (M1 pushed oracle, M2 via adapter) + insurance
  console.log("T2 CreateMarket / DepositInsurance");
  const params: MarketParams = {
    initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 600n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n,
    maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n,
  };
  const m1Kp = await newProgramAccount(P, MARKET_SIZE);
  const m1 = m1Kp.publicKey;
  const badKp = await newProgramAccount(P, MARKET_SIZE);
  await expectErr("CreateMarket bad envelope", [createMarket(P, { dex, market: badKp.publicKey, mint, oracleAuth: oracle1.publicKey, creator: funder.publicKey, creatorToken: funderTok, feeVault, params: { ...params, maxMoveBps: 500n } })], [], 103);
  await send("CreateMarket", [createMarket(P, { dex, market: m1, mint, oracleAuth: oracle1.publicKey, creator: funder.publicKey, creatorToken: funderTok, feeVault, params })]);
  ok((await tokBal(feeVault)) === 2n * POS_SCALE, "create fee paid to feeVault");
  const mk1 = parseMarket(await acct(m1));
  ok(mk1.status === STATUS.ACTIVE && mk1.markPrice === 100n * POS_SCALE && mk1.marketAdmin?.equals(funder.publicKey) === true, "parseMarket: status/mark/admin");

  const adpKp = await newProgramAccount(O, ADAPTER_CFG_SIZE);
  const [oracPda] = deriveOracleAuth(O, adpKp.publicKey);
  const m2Kp = await newProgramAccount(P, MARKET_SIZE);
  const m2 = m2Kp.publicKey;
  await send("CreateMarket(adapter oracle)", [createMarket(P, { dex, market: m2, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: funderTok, feeVault, params })]);

  const rcptKp = await newProgramAccount(P, INS_RECEIPT_SIZE);
  await send("DepositInsurance", [depositInsurance(P, V, { market: m1, receipt: rcptKp.publicKey, lp: funder.publicKey, sourceToken: funderTok, amount: 100n * POS_SCALE })]);
  const rc = parseInsReceipt(await acct(rcptKp.publicKey));
  ok(rc.shares > 0n && rc.market.equals(m1), `parseInsReceipt: shares=${rc.shares}`);
  await send("DepositInsurance(donate)", [depositInsurance(P, V, { market: m2, receipt: m2, lp: funder.publicKey, sourceToken: funderTok, amount: 5n * POS_SCALE, donate: true })]);
  ok(parseMarket(await acct(m2)).insurance === 5n * POS_SCALE, "donation credited to M2 insurance");
  await invariants("after markets", dex);

  // ---- T3 portfolios, trading, refresh bundling
  console.log("T3 InitPortfolio / Deposit / Trade / RefreshLeg / Withdraw");
  const pA = (await newProgramAccount(P, PORTFOLIO_SIZE)).publicKey;
  const pB = (await newProgramAccount(P, PORTFOLIO_SIZE)).publicKey;
  await send("InitPortfolio", [initPortfolio(P, { dex, portfolio: pA, owner: traderA.publicKey })], [traderA]);
  await send("InitPortfolio", [initPortfolio(P, { dex, portfolio: pB, owner: traderB.publicKey })], [traderB]);
  await send("DepositCollateral", [depositCollateral(P, V, { portfolio: pA, depositor: traderA.publicKey, sourceToken: aTok, amount: 100n * POS_SCALE })], [traderA]);
  await send("DepositCollateral", [depositCollateral(P, V, { portfolio: pB, depositor: traderB.publicKey, sourceToken: bTok, amount: 1_000n * POS_SCALE })], [traderB]);

  const open = (market: PublicKey, qty: bigint, execPrice = 0n) => trade(P, { dex, market, longPortfolio: pA, longOwner: traderA.publicKey, shortPortfolio: pB, shortOwner: traderB.publicKey, mode: TRADE_MODE.OPEN, qty, execPrice });
  await expectErr("Trade execPrice out of band", [open(m1, POS_SCALE, 120n * POS_SCALE)], [traderA, traderB], 130);
  await send("Trade(open)", [open(m1, 3n * POS_SCALE)], [traderA, traderB], true);
  // adapter must be initialised before M2's oracle can move, but M2 is fresh from CreateMarket: trade it now.
  await send("Trade(open)", [open(m2, POS_SCALE)], [traderA, traderB], true);
  const pa = parsePortfolio(await acct(pA));
  ok(openLegs(pa).length === 2 && pa.legs.every((l) => l.side === SIDE.LONG), `parsePortfolio: A has 2 long legs (totalIm=${pa.totalIm})`);

  await waitSlots(2);
  await expectErr("Withdraw with stale legs (no bundled refresh)", [withdrawCollateral(P, V, { portfolio: pA, owner: traderA.publicKey, destToken: aTok, amount: POS_SCALE })], [traderA], 122);
  const bundled = await withLegRefresh(conn, [withdrawCollateral(P, V, { portfolio: pA, owner: traderA.publicKey, destToken: aTok, amount: POS_SCALE })]);
  ok(bundled.added === 2, `withLegRefresh prepended ${bundled.added} RefreshLeg ixs for A's 2 open legs`);
  await send("WithdrawCollateral", bundled.instructions, [traderA]);
  covered.add("RefreshLeg");

  await send("UpdateOracle", [updateOracle(P, { market: m1, oracleAuth: oracle1.publicKey, price: 99_500_000n, fundingSign: 0, fundingE6: 10_000n })], [oracle1]);
  await waitSlots(1);
  await expectErr("UpdateOracle same-slot spam", [
    updateOracle(P, { market: m1, oracleAuth: oracle1.publicKey, price: 99n * POS_SCALE }),
    updateOracle(P, { market: m1, oracleAuth: oracle1.publicKey, price: 98n * POS_SCALE }),
  ], [oracle1], 126);
  await send("RefreshLeg", [refreshLeg(P, { dex, market: m1, portfolio: pA }), refreshLeg(P, { dex, market: m1, portfolio: pB })]);
  // 35cd13c Liquidate requires ALL legs fresh; pA's ETH leg is stale here, so either
  // positionHealthy (116) or stalePortfolioLeg (122) is a correct safe rejection.
  await expectErr("Liquidate healthy", [liquidate(P, V, { market: m1, portfolio: pA, liquidatorToken: funderTok })], [], [116, 122]);
  await expectErr("ClearDeadLeg with live OI", [clearDeadLeg(P, { dex, market: m1, portfolio: pA })], [], 118);
  await send("Trade(close)", [trade(P, { dex, market: m1, longPortfolio: pA, longOwner: traderA.publicKey, shortPortfolio: pB, shortOwner: traderB.publicKey, mode: TRADE_MODE.CLOSE, qty: POS_SCALE })], [traderA, traderB]);
  ok(parseMarket(await acct(m1)).oiLong === 2n * POS_SCALE, "Trade(close) reduced M1 OI to 2");
  await invariants("after trading", dex);

  // ---- T4 PropAMM matcher (887ba02: the matcher program is the 0-signer PropAMM; the LP owner keeps the portfolio)
  console.log("T4 PropAMM Init / Update / SetPortfolioMatcher / TradeWithMatcher / LP withdraw");
  const ctxKp = Keypair.generate();
  const ctx = ctxKp.publicKey;
  const m1Id = parseMarket(await acct(m1)).marketId;
  // create + init the ctx in ONE transaction (init is first-come on an uninitialized ctx)
  await send("matcher.Init", [
    SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: ctx, lamports: await conn.getMinimumBalanceForRentExemption(PROP_CTX_SIZE), space: PROP_CTX_SIZE, programId: M }),
    propAmmInit(M, { ctx, owner: funder.publicKey, halfSpreadBps: 40n, impactBps: 20n, maxFillQty: 10n * POS_SCALE, allowedMarketIds: [m1Id] }),
  ], [ctxKp]);
  await send("matcher.Update", [propAmmUpdate(M, { ctx, owner: funder.publicKey, paused: false, halfSpreadBps: 50n, impactBps: 20n, maxFillQty: 10n * POS_SCALE })]);
  const pc = parsePropAmmCtx(await acct(ctx));
  ok(pc.owner.equals(funder.publicKey) && !pc.paused && pc.halfSpreadBps === 50n && pc.allowedMarkets.length === 1 && pc.allowedMarkets[0] === m1Id, "parsePropAmmCtx");
  const lpPfl = (await newProgramAccount(P, PORTFOLIO_SIZE)).publicKey;
  await send("InitPortfolio", [initPortfolio(P, { dex, portfolio: lpPfl, owner: funder.publicKey })]);
  await send("SetPortfolioMatcher", [setPortfolioMatcher(P, { portfolio: lpPfl, owner: funder.publicKey, matcherCtx: ctx })]);
  ok(parsePortfolio(await acct(lpPfl)).matcherCtx.equals(ctx), "SetPortfolioMatcher bound the ctx to the LP portfolio");
  await send("DepositCollateral(LP, 3rd-party depositor)", [depositCollateral(P, V, { portfolio: lpPfl, depositor: funder.publicKey, sourceToken: funderTok, amount: 500n * POS_SCALE })]);
  // T3's oracle move was a saturated ramp tick: the PropAMM refuses to quote (matcher.paused 200) for 150 slots after it.
  const rampSlot = parseMarket(await acct(m1)).lastRampSlot;
  if (rampSlot > 0n && BigInt(await conn.getSlot("confirmed")) <= rampSlot + 140n) {
    await expectErr("matcher.Fill during ramp cooldown", [tradeWithMatcher(P, { dex, takerPortfolio: pA, taker: traderA.publicKey, lpPortfolio: lpPfl, matcherProgram: M, matcherCtx: ctx,
      legs: [{ market: m1, mode: TRADE_MODE.OPEN, takerIsLong: true, maxQty: POS_SCALE }] })], [traderA], 200, true);
  }
  if (rampSlot > 0n) {
    console.log("  (waiting out M1's 150-slot ramp cooldown)");
    while (BigInt(await conn.getSlot("confirmed")) <= rampSlot + 152n) await sleep(2000);
  }
  // single-signer taker (traderA) trade against the LP portfolio; the LP owner does not sign the trade itself
  const fill = (mode: number, limitPrice: bigint) => tradeWithMatcher(P, { dex, takerPortfolio: pA, taker: traderA.publicKey, lpPortfolio: lpPfl, matcherProgram: M, matcherCtx: ctx,
    legs: [{ market: m1, mode, takerIsLong: true, maxQty: POS_SCALE, limitPrice }] });
  await expectErr("matcher.Fill slippage", [fill(TRADE_MODE.OPEN, 99n * POS_SCALE)], [traderA], 130, true); // limit below the ask -> core execPriceClamp
  const lpEq = async () => { const f = parsePortfolio(await acct(lpPfl)); return f.capital + f.totalLockedMm; };
  const lpEq0 = await lpEq();
  await send("matcher.Fill(open)", [fill(TRADE_MODE.OPEN, 101n * POS_SCALE)], [traderA], true);
  ok((await lpEq()) > lpEq0, "LP earned spread (net of its trade fee) on taker open");
  await send("matcher.Fill(close)", [fill(TRADE_MODE.CLOSE, 1n)], [traderA], true); // taker SELLS at the bid (limit 1 = accept any bid)
  const funderBefore = await tokBal(funderTok);
  await send("matcher.WithdrawLp", [withdrawCollateral(P, V, { portfolio: lpPfl, owner: funder.publicKey, destToken: funderTok, amount: 10n * POS_SCALE })], [], true);
  ok((await tokBal(funderTok)) - funderBefore === 10n * POS_SCALE, "LP owner withdrew 10 directly (WithdrawCollateral)");

  // ---- T5 oracle adapter (mock FEED account)
  console.log("T5 Adapter Init / Crank");
  const feed = (await newProgramAccount(LEAN_DEVNET.mockFeed, 64)).publicKey;
  const writeFeed = async (price: bigint, conf: bigint) => {
    const slot = BigInt(await conn.getSlot("processed"));
    const d = Buffer.alloc(32);
    d.writeUInt32LE(MAGIC.FEED, 0); d.writeBigUInt64LE(price, 8); d.writeBigUInt64LE(conf, 16); d.writeBigUInt64LE(slot, 24);
    await send("mockFeed.write", [new TransactionInstruction({ programId: LEAN_DEVNET.mockFeed, keys: [
      { pubkey: feed, isSigner: false, isWritable: true }, { pubkey: funder.publicKey, isSigner: true, isWritable: false }], data: d })]);
  };
  await writeFeed(102n * POS_SCALE, 50_000n);
  await send("adapter.Init", [adapterInit(O, { cfg: adpKp.publicKey, admin: funder.publicKey, percolator: P, market: m2, feed, feedType: FEED_TYPE.CUSTOM, maxFeedAge: 150n, maxConfBps: 100n, fundingBpsPerStep: 10n })]);
  ok(parseAdapterConfig(await acct(adpKp.publicKey)).feed.equals(feed), "parseAdapterConfig");
  await writeFeed(102n * POS_SCALE, 5n * POS_SCALE);
  await expectErr("adapter.Crank wide confidence", [adapterCrank(O, { cfg: adpKp.publicKey, market: m2, feed, percolator: P })], [], 301);
  await writeFeed(102n * POS_SCALE, 50_000n);
  await send("adapter.Crank", [adapterCrank(O, { cfg: adpKp.publicKey, market: m2, feed, percolator: P })]);
  ok(parseMarket(await acct(m2)).markPrice === 102n * POS_SCALE, "adapter crank moved M2 mark to 102 (within clamp)");

  // ---- T6 authority ops
  console.log("T6 RotateOracle / TransferAdmin / BurnAdmin");
  await send("UpdateMarketAuth(oracle)", [rotateOracleAuth(P, { market: m1, admin: funder.publicKey, newOracle: oracle2.publicKey })]);
  await waitSlots(1);
  await expectErr("old oracle after rotation", [updateOracle(P, { market: m1, oracleAuth: oracle1.publicKey, price: 99n * POS_SCALE })], [oracle1], 102);
  await send("UpdateOracle(rotated)", [updateOracle(P, { market: m1, oracleAuth: oracle2.publicKey, price: 99n * POS_SCALE })], [oracle2]);
  await send("UpdateMarketAuth(admin)", [transferMarketAdmin(P, { market: m2, admin: funder.publicKey, newAdmin: admin2.publicKey })]);
  ok(parseMarket(await acct(m2)).marketAdmin?.equals(admin2.publicKey) === true, "M2 admin transferred");
  await send("UpdateMarketAuth(burn)", [burnMarketAdmin(P, { market: m2, admin: admin2.publicKey })], [admin2]);
  ok(parseMarket(await acct(m2)).marketAdmin === null, "M2 admin burned");

  // ---- T7 lifecycle on M1: wind-down → force-close → resolve → claim → withdraw ins → tombstone → close
  console.log("T7 WindDown / ForceClosePair / Resolve / Claim / WithdrawInsurance / Tombstone / CloseAccount");
  await send("StartWindDown(admin)", [startWindDown(P, { market: m1, caller: funder.publicKey })]);
  await expectErr("ForceClosePair during exit window", [forceClosePair(P, { dex, market: m1, longPortfolio: pA, shortPortfolio: pB })], [], 117);
  await waitSlots(12);
  await send("ForceClosePair", [forceClosePair(P, { dex, market: m1, longPortfolio: pA, shortPortfolio: pB })]);
  const mk1b = parseMarket(await acct(m1));
  ok(mk1b.oiLong === 0n && mk1b.activeLegs === 0n, "M1 fully netted");
  await send("ResolveMarket", [resolveMarket(P, { dex, market: m1 })]);
  ok(parseMarket(await acct(m1)).status === STATUS.RESOLVED, "M1 resolved");
  for (const [who, pfl] of [["A", pA], ["B", pB]] as const) {
    const leg = parsePortfolio(await acct(pfl)).legs.find((l) => l.market.equals(m1));
    if (leg) await send("ClaimResolved", [claimResolved(P, { dex, market: m1, portfolio: pfl })]);
    else console.log(`  · ${who} has no M1 leg left to claim (freed at zero PnL)`);
  }
  if (!covered.has("ClaimResolved")) {
    await expectErr("ClaimResolved without leg", [claimResolved(P, { dex, market: m1, portfolio: pA })], [], 125);
  }
  const shares = parseInsReceipt(await acct(rcptKp.publicKey)).shares;
  await send("WithdrawInsurance", [withdrawInsurance(P, V, { market: m1, receipt: rcptKp.publicKey, lp: funder.publicKey, destToken: funderTok, burnShares: shares })]);
  await send("TombstoneMarket", [tombstoneMarket(P, { market: m1 })]);
  ok(parseMarket(await acct(m1)).status === STATUS.TOMBSTONED, "M1 tombstoned");
  const lam0 = await conn.getBalance(funder.publicKey);
  await send("CloseAccount(receipt)", [closeAccount(P, { account: rcptKp.publicKey, authority: funder.publicKey, destination: admin2.publicKey })]);
  await send("CloseAccount(market)", [closeAccount(P, { account: m1, authority: funder.publicKey, destination: admin2.publicKey })]);
  ok((await conn.getAccountInfo(m1)) === null, "tombstoned M1 closed, rent reclaimed");
  void lam0;

  // A: close the M2 leg via a bilateral close, empty capital, close portfolio
  await waitSlots(1);
  await writeFeed(102n * POS_SCALE, 50_000n);
  await send("adapter.Crank", [adapterCrank(O, { cfg: adpKp.publicKey, market: m2, feed, percolator: P })]);
  await send("Trade(close)", [trade(P, { dex, market: m2, longPortfolio: pA, longOwner: traderA.publicKey, shortPortfolio: pB, shortOwner: traderB.publicKey, mode: TRADE_MODE.CLOSE, qty: POS_SCALE })], [traderA, traderB]);
  const stuck = parsePortfolio(await acct(pA)).legs.filter((l) => l.side === SIDE.FLAT && l.posPnl > 0n);
  const realize = await realizeFlatLegs(conn, pA);
  ok(realize.length === stuck.length, `realizeFlatLegs: ${realize.length} flat leg(s) with unrealized profit after close`);
  if (realize.length) await send("RefreshLeg(realize flat)", realize);
  ok(parsePortfolio(await acct(pA)).legCount === 0, "A has no legs left after realizing");
  const capA = parsePortfolio(await acct(pA)).capital;
  await expectErr("CloseAccount non-empty portfolio", [closeAccount(P, { account: pA, authority: traderA.publicKey, destination: admin2.publicKey })], [traderA], 119);
  await send("WithdrawCollateral(all)", [withdrawCollateral(P, V, { portfolio: pA, owner: traderA.publicKey, destToken: aTok, amount: capA })], [traderA], true);
  await send("CloseAccount(portfolio)", [closeAccount(P, { account: pA, authority: traderA.publicKey, destination: admin2.publicKey })], [traderA]);
  ok((await conn.getAccountInfo(pA)) === null, "empty portfolio A closed");

  // ---- T8 discovery
  console.log("T8 discovery");
  const pfls = await discoverPortfolios(conn, P, { dex });
  ok(pfls.length === 2 && pfls.some((r) => r.address.equals(pB)) && pfls.some((r) => r.address.equals(lpPfl)), `discoverPortfolios(dex) → ${pfls.length} (B + LP)`);
  const byOwner = await discoverPortfolios(conn, P, { owner: traderB.publicKey });
  ok(byOwner.length === 1 && byOwner[0].address.equals(pB), "discoverPortfolios(owner)");
  const mkts = await discoverMarkets(conn, P, { dex });
  // M1 was closed; the bad-envelope account was never initialised (no magic) so it is not a market.
  ok(mkts.length === 1 && mkts[0].address.equals(m2), `discoverMarkets(dex) → ${mkts.length} (M2)`);
  await invariants("final", dex);

  // ---- coverage report
  const required = [
    "InitDex", "UpdateCreateFee", "CreateMarket", "UpdateMarketAuth(oracle)", "UpdateMarketAuth(admin)", "UpdateMarketAuth(burn)",
    "UpdateOracle", "InitPortfolio", "DepositCollateral", "WithdrawCollateral", "DepositInsurance", "WithdrawInsurance",
    "RefreshLeg", "Trade(open)", "Trade(close)", "Liquidate healthy", "ClearDeadLeg with live OI", "StartWindDown(admin)",
    "ForceClosePair", "ResolveMarket", "TombstoneMarket", "CloseAccount(portfolio)",
    "matcher.Init", "matcher.Update", "SetPortfolioMatcher", "matcher.Fill(open)", "matcher.Fill(close)", "matcher.WithdrawLp", "adapter.Init", "adapter.Crank",
  ];
  const claimCovered = covered.has("ClaimResolved") || covered.has("ClaimResolved without leg");
  const missing = required.filter((r) => !covered.has(r));
  ok(missing.length === 0 && claimCovered, `encoder coverage: ${missing.length ? "missing " + missing.join(", ") : "all core ops + PropAMM + 2 adapter ops exercised"}`);

  const spent = (solStart - (await conn.getBalance(funder.publicKey))) / 1e9;
  console.log(`\n${passed} passed, ${failures.length} failed — spent ${spent.toFixed(4)} devnet SOL — dex ${dex.toBase58()}`);
  if (failures.length) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
  // web3.js keeps the confirmation websocket open; exit explicitly.
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
