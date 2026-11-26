/**
 * Adversarial fund-safety stress harness for percolator-lean on devnet.
 *
 * Stands up a fresh disposable DEX + market + funded portfolios + insurance, then
 * throws a battery of theft / conservation attacks that MUST be rejected, checking
 * after every attempt that:
 *   - the tx was rejected (and, where a specific code is expected, with that code),
 *   - the V == SPL conservation invariant and checkDexInvariants still hold,
 *   - no portfolio capital or dex totals were created out of nothing.
 * Then runs N randomized valid-op rounds, re-checking conservation after each.
 *
 * This complements the Rust fuzzer (random VALID ops): it targets the attack surface
 * that matters for a bug bounty — wrong token program (the A0 class), wrong mint/vault,
 * cross-DEX account confusion, aliasing, over-withdraw, bad closes.
 *
 *   SOLANA_RPC_URL=<devnet> pnpm tsx scripts/lean-attack.ts [rounds]
 *
 * Devnet only (genesis-hash guard). Spends a little devnet SOL.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE,
  assertDevnet, deriveDexVault, leanErrorName,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, withdrawCollateral,
  depositInsurance, trade, liquidate, refreshLeg, closeAccount,
  parseDex, parsePortfolio, snapshotDex, checkDexInvariants, withLegRefresh, realizeFlatLegs,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ROUNDS = parseInt(process.argv[2] ?? "40");
const conn = new Connection(RPC, "confirmed");
const P = LEAN_DEVNET.percolator;
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));

let pass = 0;
const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const rnd = (n: number) => Math.floor(Math.random() * n);

async function sendOk(ixs: TransactionInstruction[], signers: Keypair[], refresh = false): Promise<string> {
  const list = refresh ? (await withLegRefresh(conn, ixs)).instructions : ixs;
  return sendAndConfirmTransaction(conn, new Transaction().add(...list), [funder, ...signers], { commitment: "confirmed" });
}

/** Simulate; return the custom code (or a string tag for a non-custom/runtime error), or null if it SUCCEEDED. */
async function trySim(ixs: TransactionInstruction[], signers: Keypair[]): Promise<number | string | null> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(funder, ...signers);
  const r = (await conn.simulateTransaction(tx)).value;
  if (!r.err) return null;
  const ie = (r.err as any).InstructionError;
  if (ie && typeof ie[1] === "object" && "Custom" in ie[1]) return ie[1].Custom as number;
  return JSON.stringify(r.err);
}

async function snap(dex: PublicKey) {
  const s = await snapshotDex(conn, P, dex);
  return checkDexInvariants(s.dex, s.vaultTokenBalance, s.markets.map(m => m.data), s.portfolios.map(p => p.data));
}

/** An attack must be rejected AND leave conservation intact. */
async function attack(label: string, dex: PublicKey, ixs: TransactionInstruction[], signers: Keypair[], expect?: number) {
  const res = await trySim(ixs, signers);
  if (res === null) { fail.push(`SECURITY: "${label}" SUCCEEDED (should be rejected)`); console.log(`  ✗✗ ${label} SUCCEEDED`); return; }
  ok(expect === undefined || res === expect, `${label} rejected ${typeof res === "number" ? leanErrorName(res) : res}${expect !== undefined && res !== expect ? ` (wanted ${leanErrorName(expect)})` : ""}`);
  const inv = await snap(dex);
  ok(inv.ok, `  …conservation intact after "${label}"${inv.ok ? "" : " — " + inv.problems.join("; ")}`);
}

async function main() {
  await assertDevnet(conn);
  console.log(`lean-attack — ${P.toBase58()} via ${RPC} (${ROUNDS} fuzz rounds)`);
  const sol0 = await conn.getBalance(funder.publicKey);
  const newAcc = async (owner: PublicKey, size: number) => {
    const kp = Keypair.generate();
    const lam = await conn.getMinimumBalanceForRentExemption(size);
    await sendOk([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
    return kp;
  };

  // ---- setup two independent DEXes (for cross-dex confusion attacks)
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);

  const dexA = (await newAcc(P, DEX_SIZE)).publicKey;
  const dexB = (await newAcc(P, DEX_SIZE)).publicKey;
  for (const d of [dexA, dexB]) await sendOk([initDex(P, { dex: d, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })], []);
  const dA = parseDex(Buffer.from((await conn.getAccountInfo(dexA))!.data));
  const dB = parseDex(Buffer.from((await conn.getAccountInfo(dexB))!.data));
  const VA: VaultAccounts = { dex: dexA, mint, vault: dA.vault };
  const VB: VaultAccounts = { dex: dexB, mint, vault: dB.vault };

  const params: MarketParams = {
    initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 600n, warmupSlots: 0n,
    imBps: 1000n, mmBps: 500n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n,
    maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n,
  };
  const oracle = Keypair.generate();
  const mktA = (await newAcc(P, MARKET_SIZE)).publicKey;
  await sendOk([createMarket(P, { dex: dexA, market: mktA, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })], []);
  const insA = (await newAcc(P, INS_RECEIPT_SIZE)).publicKey;
  await sendOk([depositInsurance(P, VA, { market: mktA, receipt: insA, lp: funder.publicKey, sourceToken: fTok, amount: 500n * POS_SCALE })], []);

  // funded portfolios on dexA
  const owners = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const pfls: PublicKey[] = [];
  for (const o of owners) {
    const pf = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
    await sendOk([initPortfolio(P, { dex: dexA, portfolio: pf, owner: o.publicKey })], [o]);
    await sendOk([depositCollateral(P, VA, { portfolio: pf, depositor: funder.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE })], []);
    pfls.push(pf);
  }
  // a portfolio on dexB (cross-dex attacker)
  const ownerB = Keypair.generate();
  const pflB = (await newAcc(P, PORTFOLIO_SIZE)).publicKey;
  await sendOk([initPortfolio(P, { dex: dexB, portfolio: pflB, owner: ownerB.publicKey })], [ownerB]);

  ok((await snap(dexA)).ok, "baseline conservation (dexA)");
  const randKey = () => Keypair.generate().publicKey;

  console.log("== attacks (each must be rejected + leave conservation intact) ==");
  const [pA, pB, pC] = pfls;
  const [oA, oB] = owners;
  // A0 class: wrong token program on deposit/withdraw
  await attack("deposit w/ Noop token prog (A0)", dexA, [depositCollateral(P, { ...VA, tokenProgram: NOOP }, { portfolio: pA, depositor: oA.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE })], [oA], 120);
  await attack("deposit w/ Token-2022 (A0)", dexA, [depositCollateral(P, { ...VA, tokenProgram: TOKEN_2022 }, { portfolio: pA, depositor: oA.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE })], [oA], 120);
  await attack("depositInsurance w/ Noop (A0)", dexA, [depositInsurance(P, { ...VA, tokenProgram: NOOP }, { market: mktA, receipt: insA, lp: oA.publicKey, sourceToken: fTok, amount: 1_000n * POS_SCALE })], [oA], 120);
  await attack("withdraw w/ Noop token prog", dexA, [withdrawCollateral(P, { ...VA, tokenProgram: NOOP }, { portfolio: pA, owner: oA.publicKey, destToken: fTok, amount: 1n })], [oA], 120);
  // wrong mint / wrong vault
  await attack("deposit w/ wrong vault", dexA, [depositCollateral(P, { ...VA, vault: dB.vault }, { portfolio: pA, depositor: oA.publicKey, sourceToken: fTok, amount: 100n })], [oA], 113);
  await attack("deposit w/ wrong mint", dexA, [depositCollateral(P, { ...VA, mint: randKey() }, { portfolio: pA, depositor: oA.publicKey, sourceToken: fTok, amount: 100n })], [oA], 112);
  await attack("withdraw w/ wrong vault", dexA, [withdrawCollateral(P, { ...VA, vault: dB.vault }, { portfolio: pA, owner: oA.publicKey, destToken: fTok, amount: 100n })], [oA], 113);
  // cross-dex confusion: dexB portfolio against dexA market vault
  await attack("cross-dex: dexB pfl deposits to dexA", dexA, [depositCollateral(P, VA, { portfolio: pflB, depositor: ownerB.publicKey, sourceToken: fTok, amount: 100n })], [ownerB], 127);
  // over-withdraw beyond capital
  await attack("withdraw > capital", dexA, [withdrawCollateral(P, VA, { portfolio: pA, owner: oA.publicKey, destToken: fTok, amount: 10_000n * POS_SCALE })], [oA], 108);
  // withdraw as wrong owner
  await attack("withdraw as non-owner", dexA, [withdrawCollateral(P, VA, { portfolio: pA, owner: oB.publicKey, destToken: fTok, amount: 100n })], [oB], 111);
  // aliased trade (long == short)
  await attack("aliased trade (L==S)", dexA, [trade(P, { dex: dexA, market: mktA, longPortfolio: pA, longOwner: oA.publicKey, shortPortfolio: pA, shortOwner: oA.publicKey, mode: TRADE_MODE.OPEN, qty: POS_SCALE })], [oA]);
  // open a real position so liquidate-healthy exercises positionHealthy (not legNotFound)
  await sendOk([trade(P, { dex: dexA, market: mktA, longPortfolio: pA, longOwner: oA.publicKey, shortPortfolio: pB, shortOwner: oB.publicKey, mode: TRADE_MODE.OPEN, qty: 2n * POS_SCALE })], [oA, oB], true);
  ok((await snap(dexA)).ok, "conservation after opening pA/pB position");
  // liquidate a healthy portfolio
  await attack("liquidate healthy", dexA, [liquidate(P, VA, { market: mktA, portfolio: pA, liquidatorToken: fTok })], [], 116);
  // close a non-empty portfolio
  await attack("close non-empty portfolio", dexA, [closeAccount(P, { account: pA, authority: oA.publicKey, destination: funder.publicKey })], [oA], 119);
  // exploit chain: noop deposit + real withdraw in one atomic tx
  await attack("chain: noop-deposit + withdraw", dexA, [
    depositCollateral(P, { ...VA, tokenProgram: NOOP }, { portfolio: pA, depositor: oA.publicKey, sourceToken: fTok, amount: 5_000n * POS_SCALE }),
    withdrawCollateral(P, VA, { portfolio: pA, owner: oA.publicKey, destToken: fTok, amount: 5_000n * POS_SCALE }),
  ], [oA], 120);

  // ---- randomized VALID ops with conservation after each
  console.log(`== ${ROUNDS} randomized valid-op rounds (conservation checked each) ==`);
  let price = 100n * POS_SCALE;
  for (let i = 0; i < ROUNDS; i++) {
    const act = rnd(5);
    try {
      if (act === 0) {
        price = price + BigInt(rnd(300) - 150) * POS_SCALE / 100n;
        if (price < 50n * POS_SCALE) price = 50n * POS_SCALE;
        if (price > 150n * POS_SCALE) price = 150n * POS_SCALE;
        await sendOk([updateOracle(P, { market: mktA, oracleAuth: oracle.publicKey, price })], [oracle]);
      } else if (act === 1) {
        const li = rnd(3), si = (li + 1 + rnd(2)) % 3;
        await sendOk([trade(P, { dex: dexA, market: mktA, longPortfolio: pfls[li], longOwner: owners[li].publicKey, shortPortfolio: pfls[si], shortOwner: owners[si].publicKey, mode: TRADE_MODE.OPEN, qty: BigInt(rnd(3) + 1) * POS_SCALE })], [owners[li], owners[si]], true);
      } else if (act === 2) {
        const k = rnd(3);
        await sendOk([refreshLeg(P, { dex: dexA, market: mktA, portfolio: pfls[k] })], []);
      } else if (act === 3) {
        const k = rnd(3);
        await sendOk([depositCollateral(P, VA, { portfolio: pfls[k], depositor: funder.publicKey, sourceToken: fTok, amount: BigInt(rnd(50) + 1) * POS_SCALE })], []);
      } else {
        const k = rnd(3);
        const ixs = [...await realizeFlatLegs(conn, pfls[k]), withdrawCollateral(P, VA, { portfolio: pfls[k], owner: owners[k].publicKey, destToken: fTok, amount: POS_SCALE })];
        await sendOk(ixs, [owners[k]], true);
      }
    } catch { /* an occasional invalid op (margin, slot) is fine; conservation is the invariant */ }
    const inv = await snap(dexA);
    ok(inv.ok, `round ${i} conservation${inv.ok ? "" : " — " + inv.problems.join("; ")}`);
    if (!inv.ok) break;
  }

  const spent = (sol0 - await conn.getBalance(funder.publicKey)) / 1e9;
  const sec = fail.filter(f => f.startsWith("SECURITY")).length;
  console.log(`\n${pass} checks passed, ${fail.length} failed (${sec} security) — spent ${spent.toFixed(4)} SOL — dexA ${dexA.toBase58()}`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("CLEAN — no theft, conservation held throughout.");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
