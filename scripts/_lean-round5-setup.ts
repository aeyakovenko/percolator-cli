/**
 * ROUND-5 BOUNTY REHEARSAL — DEVNET SETUP of the full product (percolator-lean 887ba02).
 *
 * Stands up, on a FRESH disposable mint + DEX, the three prize surfaces the next mainnet
 * capture-the-flag exposes:
 *   (1) a funded USER POSITION (a long, targeting 0.003 BTC) held AGAINST THE VAULT,
 *   (2) a passive AMM VAULT  — an always-available PropAMM counterparty: an LP portfolio
 *       + a 272-byte ctx bound with SetPortfolioMatcher (single-signature taker trades),
 *   (3) the market INSURANCE fund.
 * Market config is the round-5 target: BTC/USD-like, 6-decimal collateral, imBps 1000 /
 * mmBps 600 / liqFee 50 / tradeFee 2 bps / maxMove 100 / maxInsDraw 2500, built-in HL/Binance
 * funding ON, a SHORT maxStaleness (default 300 slots), reward module optional (R5_REWARD=1).
 * Initial mark = the LIVE BTC spot (Coinbase + Kraken median).
 *
 * Writes a manifest JSON + the (devnet-only, throwaway) oracle / LP / user / attacker keys to
 * an OUT_DIR under the scratchpad (NEVER into the repo). Re-runnable: if OUT_DIR already holds a
 * live Active market, it reuses it (pass --force to rebuild).
 *
 *   R5_OUT=<dir> LEAN_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-round5-setup.ts [--force]
 *   R5_OUT=<dir> LEAN_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-round5-setup.ts --keeper
 *        ^ runs the oracle quote keeper daemon (LIVE Coinbase/Kraken spot) against the manifest's
 *          market until SIGINT — the vault stays fresh. (Prints the equivalent standalone command too.)
 *
 * DEVNET ONLY (genesis-hash guard). The funder = ~/.config/solana/id.json (devnet SOL).
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, initPortfolio, depositCollateral, depositInsurance,
  packFundingCfg, assertDevnet, deriveDexVault, parseDex, parseMarket, parsePortfolio,
  QuoteKeeper, maskSecrets, coinbaseSource, krakenSource,
  type MarketParams, type VaultAccounts, type SpotSource,
} from "../src/lean/index.js";
import { propAmmVault, type VaultAdapter } from "./_lean-round5-vault.js";

// ---------------------------------------------------------------- product constants (round-5 defaults)
export const INSURANCE_USD = 23;       // insurance fund seed
export const VAULT_USD      = 23;       // passive AMM vault LP capital
export const USER_USD       = 23;       // user position collateral
export const USER_BTC_SIZE  = 0.003;    // target user long size (BTC)
// recommended PropAMM / keeper parameters (see ROUND5-REHEARSAL.md)
export const HALF_SPREAD_BPS = 20n;     // > tradeFeeBps(2) so the LP nets a profit per side
export const IMPACT_BPS      = 3000n;   // per 1.0 BTC filled: 0.001 BTC -> 3 bps extra
export const MAX_STALENESS   = BigInt(process.env.R5_MAX_STALENESS ?? "300");
export const KEEPER_THRESHOLD_BPS = Number(process.env.R5_THRESHOLD_BPS ?? "10");

const HOME = process.env.HOME ?? os.homedir();
const OUT_DIR = process.env.R5_OUT ?? path.join(os.tmpdir(), "lean-round5");
const RPC = process.env.LEAN_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const M = new PublicKey(process.env.LEAN_MATCHER ?? LEAN_DEVNET.matcher.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${HOME}/.config/solana/id.json`, "utf8"))));
const vault: VaultAdapter = propAmmVault(M);   // the ONE AMM touch-point (swap for oracleAmmVault later)

const say = (s: string) => console.log(maskSecrets(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const e6 = (p: number) => BigInt(Math.round(p * 1e6));
const usd = (n: bigint) => (Number(n) / 1e6).toFixed(2);
const btc = (q: bigint) => (Number(q) / 1e6).toFixed(6);
let nonce = 1;
const uniq = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: nonce++ });

async function send(ixs: TransactionInstruction[], s: Keypair[] = []) {
  for (let i = 0; ; i++) {
    try { return await sendAndConfirmTransaction(conn, new Transaction().add(uniq(), ...ixs), [funder, ...s], { commitment: "confirmed" }); }
    catch (e) { if (i < 6 && /429|Too Many|block height|timed out|fetch failed|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; }
  }
}
async function newAcc(o: PublicKey, sz: number, kp = Keypair.generate()) {
  const lam = await conn.getMinimumBalanceForRentExemption(sz);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]);
  return kp;
}
const mktOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m, "confirmed"))!.data));

// ---------------------------------------------------------------- live BTC spot (median of Coinbase + Kraken)
async function liveBtc(): Promise<number> {
  const srcs = [coinbaseSource({ timeoutMs: 5000 }), krakenSource({ timeoutMs: 5000 })];
  const now = Date.now();
  const reads = await Promise.all(srcs.map((s) => s.read(now)));
  const px = reads.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.price).sort((a, b) => a - b);
  if (px.length === 0) throw new Error("could not fetch live BTC spot from Coinbase or Kraken");
  const mid = px.length === 1 ? px[0] : (px[0] + px[px.length - 1]) / 2;
  return Math.round(mid * 100) / 100;
}

interface Manifest {
  network: "devnet"; createdAt: string; percolator: string; matcher: string;
  dex: string; mint: string; vault: string; feeVault: string; funderToken: string;
  market: string; marketId: string; oracleAuth: string;
  insuranceReceipt: string; insuranceUsd: number;
  lpPortfolio: string; lpOwner: string; matcherCtx: string; vaultUsd: number;
  userPortfolio: string; userOwner: string; userUsd: number; userLongQty: string; userLongBtc: string;
  initPriceUsd: number; maxStaleness: string; halfSpreadBps: string; impactBps: string; maxFillQty: string;
  thresholdBps: number; reward: boolean;
}
const manifestPath = path.join(OUT_DIR, "manifest.json");
const keyPath = (name: string) => path.join(OUT_DIR, `${name}.json`);
const writeKey = (name: string, kp: Keypair) => fs.writeFileSync(keyPath(name), JSON.stringify([...kp.secretKey]), { mode: 0o600 });
const loadKey = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath(name), "utf8"))));

async function existingLiveMarket(): Promise<Manifest | null> {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const m: Manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const mkt = await conn.getAccountInfo(new PublicKey(m.market), "confirmed");
    if (!mkt) return null;
    const parsed = parseMarket(Buffer.from(mkt.data));
    return parsed.status === 0 ? m : null; // ACTIVE
  } catch { return null; }
}

// ---------------------------------------------------------------- keeper daemon mode
async function runKeeper(m: Manifest) {
  const oracle = loadKey("oracle");
  const market = new PublicKey(m.market);
  const sources: SpotSource[] = [coinbaseSource({}), krakenSource({})];
  const keeper = new QuoteKeeper({
    conn, programId: new PublicKey(m.percolator), market, oracle, funder,
    sources, log: (l) => say(`${new Date().toISOString()} ${l}`),
    config: { live: true, thresholdBps: m.thresholdBps, pollMs: 2000, fastPollMs: 500, minIntervalMs: 8000, statsMs: 60000, heartbeatFraction: 0.4, maxPushesPerHour: 120 },
  });
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { say(`\n${sig}: stopping keeper`); ac.abort(); });
  say(`ROUND-5 keeper LIVE on devnet: market ${market.toBase58()}, maxStaleness ${m.maxStaleness}, threshold ${m.thresholdBps} bps.`);
  await keeper.run(ac.signal);
  say("keeper stopped.");
}

// ---------------------------------------------------------------- full setup
async function main() {
  await assertDevnet(conn);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const keeperMode = process.argv.includes("--keeper");
  const force = process.argv.includes("--force");

  if (keeperMode) {
    const m = await existingLiveMarket();
    if (!m) { say(`no live Active market in ${manifestPath}; run setup first.`); process.exit(1); }
    await runKeeper(m);
    return;
  }

  const existing = await existingLiveMarket();
  if (existing && !force) {
    say(`reusing live Active market from ${manifestPath}:`);
    say(JSON.stringify(existing, null, 2));
    printKeeperInstructions(existing);
    return;
  }

  const px = await liveBtc();
  say(`live BTC spot = $${px.toLocaleString()} (initial mark)`);
  const initPrice = e6(px);
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });

  // ---- fresh identities (devnet throwaways; persisted to OUT_DIR so --keeper/attacks can reuse them)
  const oracle = Keypair.generate(), lpOwner = Keypair.generate(), userOwner = Keypair.generate(), attacker = Keypair.generate();
  for (const [n, k] of [["oracle", oracle], ["lp-owner", lpOwner], ["user-owner", userOwner], ["attacker", attacker]] as const) writeKey(n, k);

  // ---- tokens + DEX
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);
  const dexKp = await newAcc(P, DEX_SIZE);
  const dex = dexKp.publicKey;
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  say(`DEX ${dex.toBase58()} mint ${mint.toBase58()}`);

  // ---- market (round-5 config)
  const reward = process.env.R5_REWARD === "1";
  if (reward) say("R5_REWARD=1 requested, but reward-module wiring (target mint/escrow/wSOL burn-sink) is NOT cheap on devnet; skipping and leaving rewardBps=0. See report.");
  const params: MarketParams = {
    initPrice, exitWindow: 10n, maxStaleness: MAX_STALENESS, fundingCfg,
    imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n,
    maxOi: 1_000_000n * POS_SCALE, minMm: 0n,
  };
  const mktKp = await newAcc(P, MARKET_SIZE);
  const mkt = mktKp.publicKey;
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const m0 = await mktOf(mkt);
  const marketId = m0.marketId;
  say(`MARKET ${mkt.toBase58()} id ${marketId} mark $${usd(m0.markPrice)} maxStaleness ${m0.maxStaleness} fundingCfg ${m0.fundingCfg !== 0n ? "ON" : "off"}`);

  // ---- (3) insurance
  const insKp = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: insKp.publicKey, lp: funder.publicKey, sourceToken: fTok, amount: e6(INSURANCE_USD) })]);
  say(`INSURANCE seeded $${INSURANCE_USD} -> market.insurance $${usd((await mktOf(mkt)).insurance)}`);

  // ---- (2) AMM vault: LP portfolio + PropAMM ctx (create+init in ONE tx) + bind + capital
  // size maxFillQty to what the $VAULT_USD LP can actually underwrite at imBps 1000 (cap single-trade exposure).
  const notionalPerBtc = Number(initPrice) / 1e6;           // USD per 1.0 BTC
  const vaultMarginBtc = (VAULT_USD * 0.9) / (notionalPerBtc * 0.10); // 90% of capital at 10% IM
  const maxFillQty = e6(Math.max(0.0001, Math.min(USER_BTC_SIZE, vaultMarginBtc)));
  const ctxKp = Keypair.generate();
  const ctx = ctxKp.publicKey;
  const ctxRent = BigInt(await conn.getMinimumBalanceForRentExemption(vault.ctxSize));
  await send(vault.initCtxIxs({ ctx, owner: lpOwner.publicKey, payer: funder.publicKey, rentLamports: ctxRent, params: { halfSpreadBps: HALF_SPREAD_BPS, impactBps: IMPACT_BPS, maxFillQty }, allowedMarketIds: [marketId] }), [ctxKp, lpOwner]);
  const lpPfl = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: lpPfl, owner: lpOwner.publicKey })], [lpOwner]);
  await send([vault.bindIx({ percolator: P, portfolio: lpPfl, owner: lpOwner.publicKey, ctx })], [lpOwner]);
  await send([depositCollateral(P, V, { portfolio: lpPfl, depositor: funder.publicKey, sourceToken: fTok, amount: e6(VAULT_USD) })]);
  say(`AMM VAULT: LP portfolio ${lpPfl.toBase58()} capital $${VAULT_USD}, ctx ${ctx.toBase58()} halfSpread ${HALF_SPREAD_BPS}bps impact ${IMPACT_BPS} maxFillQty ${btc(maxFillQty)} BTC`);

  // ---- (1) user position: open a long AGAINST THE VAULT via TradeWithMatcher (single-signer taker)
  const userPfl = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await send([initPortfolio(P, { dex, portfolio: userPfl, owner: userOwner.publicKey })], [userOwner]);
  await send([depositCollateral(P, V, { portfolio: userPfl, depositor: funder.publicKey, sourceToken: fTok, amount: e6(USER_USD) })]);
  // physical sizing: a 0.003 BTC long at live BTC needs ~$notional; the $VAULT_USD vault can only underwrite maxFillQty.
  const userTargetQty = e6(USER_BTC_SIZE);
  const userMarginBtc = (USER_USD * 0.9) / (notionalPerBtc * 0.10);
  const wantQty = BigInt(Math.min(Number(userTargetQty), Math.floor(userMarginBtc * 1e6)));
  if (wantQty < userTargetQty) say(`NOTE: 0.003 BTC at $${px.toLocaleString()} = $${(USER_BTC_SIZE * notionalPerBtc).toFixed(0)} notional; a $${USER_USD} user / $${VAULT_USD} vault can only margin ~${btc(wantQty > maxFillQty ? maxFillQty : wantQty)} BTC. Opening the marginable size (clamped by vault maxFillQty).`);
  const ctxView = await vault.readCtx(conn, ctx);
  const leg = { market: mkt, marketId, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: wantQty, markPrice: m0.markPrice, maxMoveBps: m0.maxMoveBps };
  const q = vault.predict(ctxView, [leg]);
  say(`predicted user fill: qty ${btc(q[0].fillQty)} BTC @ ask $${usd(q[0].execPrice)} (mark $${usd(m0.markPrice)}, +${q[0].effBps}bps)`);
  const fillIxs = await vault.takerFill(conn, { percolator: P, dex, taker: userOwner.publicKey, takerPortfolio: userPfl, lpPortfolio: lpPfl, ctx, legs: [leg] });
  await send(fillIxs, [userOwner]);
  const up = parsePortfolio(Buffer.from((await conn.getAccountInfo(userPfl))!.data));
  const userLeg = up.legs.find((l) => l.market.equals(mkt));
  const filledQty = userLeg?.rawBasis ?? 0n;
  say(`USER POSITION opened: ${btc(filledQty)} BTC long, user capital now $${usd(up.capital)} (legs ${up.legCount})`);

  // ---- conservation check (DEX + vault in ONE call)
  const [dA, vA] = await conn.getMultipleAccountsInfo([dex, V.vault], "confirmed");
  const d = parseDex(Buffer.from(dA!.data));
  const spl = Buffer.from(vA!.data).readBigUInt64LE(64);
  const cons = d.vaultBalance === spl && spl === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards;
  say(`conservation V==SPL==C+I+R+S+Rew: ${cons} (V ${usd(d.vaultBalance)} = C ${usd(d.totalCapital)} + I ${usd(d.totalInsurance)} + R ${usd(d.totalResidual)} + S ${usd(d.totalSurplus)} + Rew ${usd(d.totalRewards)})`);

  const manifest: Manifest = {
    network: "devnet", createdAt: new Date().toISOString(), percolator: P.toBase58(), matcher: M.toBase58(),
    dex: dex.toBase58(), mint: mint.toBase58(), vault: V.vault.toBase58(), feeVault: feeVault.toBase58(), funderToken: fTok.toBase58(),
    market: mkt.toBase58(), marketId: marketId.toString(), oracleAuth: oracle.publicKey.toBase58(),
    insuranceReceipt: insKp.publicKey.toBase58(), insuranceUsd: INSURANCE_USD,
    lpPortfolio: lpPfl.toBase58(), lpOwner: lpOwner.publicKey.toBase58(), matcherCtx: ctx.toBase58(), vaultUsd: VAULT_USD,
    userPortfolio: userPfl.toBase58(), userOwner: userOwner.publicKey.toBase58(), userUsd: USER_USD, userLongQty: filledQty.toString(), userLongBtc: btc(filledQty),
    initPriceUsd: px, maxStaleness: MAX_STALENESS.toString(), halfSpreadBps: HALF_SPREAD_BPS.toString(), impactBps: IMPACT_BPS.toString(), maxFillQty: maxFillQty.toString(),
    thresholdBps: KEEPER_THRESHOLD_BPS, reward,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  say(`\nmanifest -> ${manifestPath}`);
  printKeeperInstructions(manifest);
  process.exit(cons ? 0 : 1); // web3 keeps the confirmation websocket open; exit explicitly
}

function printKeeperInstructions(m: Manifest) {
  say(`\n--- run the oracle quote keeper (keeps the vault fresh) ---`);
  say(`  in-process :  R5_OUT=${OUT_DIR} LEAN_RPC_URL=<devnet> npx -y tsx scripts/_lean-round5-setup.ts --keeper`);
  say(`  standalone :  LEAN_CLUSTER=devnet LEAN_RPC_URL=<devnet> LEAN_MANIFEST=${manifestPath} ORACLE_KEYPAIR=${keyPath("oracle")} \\`);
  say(`                THRESHOLD_BPS=${m.thresholdBps} HEARTBEAT_FRACTION=0.4 npx -y tsx scripts/_lean-quote-keeper.ts --live`);
}

main().catch((e) => { console.error(maskSecrets(String(e)).slice(0, 800)); process.exit(1); });
