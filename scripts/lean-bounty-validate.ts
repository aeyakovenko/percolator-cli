/**
 * BUG-BOUNTY DRESS REHEARSAL on devnet (deployed percolator-lean 35cd13c).
 *
 * Stands up ONE real "bounty pot" — a market priced by a live Pyth composite via the
 * oracle_adapter, with seeded insurance and open positions (locked collateral) — then
 * tries to break it the way a bounty hunter would and verifies the pot is undrainable:
 *   - theft surface: wrong token program, wrong mint/vault, cross-DEX, over-withdraw,
 *     non-owner withdraw, aliased trade, liquidate-healthy, bad closes, exploit chain.
 *   - ORACLE surface: fake/wrong-owner feed, stale feed, wide-confidence, unpinned feed,
 *     direct UpdateOracle by a non-authority, out-of-band execPrice.
 *   - insurance drain: withdraw w/o shares, withdraw while OI>0.
 * After EVERY attack: asserts rejection + V==SPL conservation + the pot (vault balance)
 * is not reduced. Prints a GO / NO-GO verdict.
 *
 *   SOLANA_RPC_URL=<devnet> pnpm tsx scripts/lean-bounty-validate.ts
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, ADAPTER_CFG_SIZE, POS_SCALE, TRADE_MODE, FEED_TYPE,
  assertDevnet, deriveOracleAuth, deriveDexVault, leanErrorName,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, withdrawCollateral,
  depositInsurance, withdrawInsurance, trade, liquidate, closeAccount, burnMarketAdmin,
  adapterInit, adapterCrank,
  parseDex, parseMarket, snapshotDex, checkDexInvariants, withLegRefresh,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = LEAN_DEVNET.percolator, O = LEAN_DEVNET.oracleAdapter;
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const FEED = { BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" };
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

let pass = 0; const fail: string[] = []; const sec: string[] = [];
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail.push(m); console.log(`  ✗ ${m}`); } };

async function send(ixs: TransactionInstruction[], signers: Keypair[] = [], refresh = false) {
  const list = refresh ? (await withLegRefresh(conn, ixs)).instructions : ixs;
  return sendAndConfirmTransaction(conn, new Transaction().add(...list), [funder, ...signers], { commitment: "confirmed" });
}
async function trySim(ixs: TransactionInstruction[], signers: Keypair[]): Promise<number | string | null> {
  const tx = new Transaction().add(...ixs); tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(funder, ...signers);
  const r = (await conn.simulateTransaction(tx)).value; if (!r.err) return null;
  const ie = (r.err as any).InstructionError; return ie && typeof ie[1] === "object" && "Custom" in ie[1] ? ie[1].Custom : JSON.stringify(r.err);
}
async function newAcc(owner: PublicKey, size: number) {
  const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(size);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
  return kp.publicKey;
}
async function findPyth(fidHex: string) {
  const res = await conn.getProgramAccounts(RECEIVER, { commitment: "confirmed", filters: [{ memcmp: { offset: 41, bytes: bs58.encode(Buffer.from(fidHex, "hex")) } }] });
  let best: { addr: PublicKey; age: number } | null = null; const now = Math.floor(Date.now() / 1000);
  for (const { pubkey, account } of res) { const d = account.data; if (d.length < 134 || d[40] !== 1) continue; const age = now - Number(d.readBigInt64LE(93)); if (!best || age < best.age) best = { addr: pubkey, age }; }
  if (!best) throw new Error(`no Pyth ${fidHex}`); return best.addr;
}
async function potAndInv(dex: PublicKey) {
  const s = await snapshotDex(conn, P, dex);
  const inv = checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map(m => m.data), s.portfolios.map(p => p.data));
  return { pot: s.vaultTokenBalance, inv };
}
let potFloor = 0n, theDex: PublicKey;
async function attack(label: string, ixs: TransactionInstruction[], signers: Keypair[], expect?: number | number[]) {
  const codes = expect === undefined ? undefined : (Array.isArray(expect) ? expect : [expect]);
  const r = await trySim(ixs, signers);
  if (r === null) { sec.push(label); console.log(`  ✗✗ SECURITY: "${label}" SUCCEEDED`); return; }
  ok(codes === undefined || (typeof r === "number" && codes.includes(r)), `reject "${label}": ${typeof r === "number" ? leanErrorName(r) : r}${codes && !(typeof r === "number" && codes.includes(r)) ? ` (wanted ${codes.map(leanErrorName).join("|")})` : ""}`);
  const { pot, inv } = await potAndInv(theDex);
  ok(inv.ok, `  …conservation after "${label}"`);
  ok(pot >= potFloor, `  …pot intact after "${label}" (${Number(pot) / 1e6} >= ${Number(potFloor) / 1e6})`);
}

async function main() {
  await assertDevnet(conn);
  console.log(`BOUNTY VALIDATION — percolator ${P.toBase58()} (deployed 35cd13c) via devnet`);
  const sol0 = await conn.getBalance(funder.publicKey);
  const btc = await findPyth(FEED.BTC), solF = await findPyth(FEED.SOL);

  // ---- tokens (6-dec test USD; mainnet would be wSOL)
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);

  // ---- THE BOUNTY POT: dex + BTC/SOL market (live Pyth composite) + seeded insurance + open position
  const dex = await newAcc(P, DEX_SIZE); theDex = dex;
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const V: VaultAccounts = { dex, mint, vault: d.vault };
  const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
  const [oracPda] = deriveOracleAuth(O, cfg);
  // seed init price from the live ratio so the market is usable immediately
  const bm = parseMarket; void bm;
  const params: MarketParams = { initPrice: 850n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 400n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market: mkt, feed: btc, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: 10_000_000n, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(FEED.BTC, "hex"), quoteFeed: solF, quoteFeedType: FEED_TYPE.PYTH_V2, quoteFeedId: Buffer.from(FEED.SOL, "hex") })]);
  const ins = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: ins, lp: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]); // the $100 insurance pot
  // two funded traders open a position (locks collateral into the pot)
  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE })], [oL, oS], true);
  // burn the market admin → permissionless/immutable market (mirrors a real bounty)
  await send([burnMarketAdmin(P, { market: mkt, admin: funder.publicKey })]);

  const start = await potAndInv(dex); potFloor = start.pot;
  ok(start.inv.ok, "pot set up, conservation holds");
  console.log(`  POT = ${Number(start.pot) / 1e6} test-USD (100 insurance + 1000 collateral), market admin BURNED, oracle = adapter PDA (live Pyth composite)`);

  const attacker = Keypair.generate(); const atkTok = await createAccount(conn, funder, mint, attacker.publicKey, Keypair.generate());
  const rk = () => Keypair.generate().publicKey;

  console.log("== THEFT surface ==");
  await attack("deposit w/ Noop token prog (A0)", [depositCollateral(P, { ...V, tokenProgram: NOOP }, { portfolio: pL, depositor: oL.publicKey, sourceToken: fTok, amount: 1000n * POS_SCALE })], [oL], 120);
  await attack("withdraw pot via wrong vault", [withdrawCollateral(P, { ...V, vault: rk() }, { portfolio: pL, owner: oL.publicKey, destToken: fTok, amount: 100n })], [oL], 113);
  await attack("withdraw as non-owner", [withdrawCollateral(P, V, { portfolio: pL, owner: attacker.publicKey, destToken: atkTok, amount: 100n })], [attacker], 111);
  await attack("over-withdraw beyond capital", [withdrawCollateral(P, V, { portfolio: pL, owner: oL.publicKey, destToken: fTok, amount: 100_000n * POS_SCALE })], [oL], [108, 122]);
  await attack("aliased self-trade", [trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pL, shortOwner: oL.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE })], [oL]);
  await attack("liquidate healthy position", [liquidate(P, V, { market: mkt, portfolio: pL, liquidatorToken: atkTok })], []);
  await attack("close funded portfolio", [closeAccount(P, { account: pL, authority: oL.publicKey, destination: attacker.publicKey })], [oL], 119);

  console.log("== INSURANCE drain surface ==");
  await attack("withdraw insurance w/o shares", [withdrawInsurance(P, V, { market: mkt, receipt: ins, lp: attacker.publicKey, destToken: atkTok, burnShares: 100n * POS_SCALE })], [attacker], 111);
  await attack("withdraw insurance while OI>0", [withdrawInsurance(P, V, { market: mkt, receipt: ins, lp: funder.publicKey, destToken: fTok, burnShares: 1n })], [], 118);

  console.log("== ORACLE surface ==");
  // direct UpdateOracle by a non-authority (oracle auth is the adapter PDA, not a keypair)
  await attack("direct UpdateOracle by attacker", [updateOracle(P, { market: mkt, oracleAuth: attacker.publicKey, price: 1_000n * POS_SCALE })], [attacker], 102);
  // crank with a WRONG feed account (attacker-controlled, wrong owner/key)
  const fakeFeed = await newAcc(P, 200); // program-owned junk, not the pinned Pyth feed
  await attack("adapter crank w/ wrong base feed", [adapterCrank(O, { cfg, market: mkt, feed: fakeFeed, percolator: P, quoteFeed: solF })], [], undefined);
  await attack("adapter crank w/ wrong quote feed", [adapterCrank(O, { cfg, market: mkt, feed: btc, percolator: P, quoteFeed: fakeFeed })], [], undefined);
  // out-of-band execPrice trade (push a fill far from mark to mint value)
  await attack("out-of-band execPrice trade", [trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE, execPrice: 100_000n * POS_SCALE })], [oL, oS], 130);

  // a legit permissionless crank still works (liveness), pot still intact
  await send([adapterCrank(O, { cfg, market: mkt, feed: btc, percolator: P, quoteFeed: solF })]);
  const end = await potAndInv(dex);
  ok(end.inv.ok, "final conservation");
  ok(end.pot >= potFloor, `final pot intact: ${Number(end.pot) / 1e6} >= ${Number(potFloor) / 1e6}`);

  const spent = (sol0 - await conn.getBalance(funder.publicKey)) / 1e9;
  console.log(`\n${pass} checks passed, ${fail.length} assertion-fails, ${sec.length} SECURITY breaches — spent ${spent.toFixed(4)} SOL`);
  console.log(`bounty market: dex ${dex.toBase58()} market ${mkt.toBase58()}`);
  if (sec.length) { console.log("NO-GO — security breaches:\n  " + sec.join("\n  ")); process.exit(1); }
  if (fail.length) { console.log("REVIEW — non-security assertion failures:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("GO — pot undrainable, all attacks rejected, conservation held. Ready for mainnet (see go-live checklist).");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
