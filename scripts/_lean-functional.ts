/** Functional/economic correctness of the perp DEX: long profits when price rises, short loses the
 *  matching amount, PnL magnitude = qty*Δprice, and an underwater position becomes liquidatable. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, trade, refreshLeg, liquidate,
  deriveDexVault, parseDex, parsePortfolio, parseMarket, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
let pass = 0; const fail: string[] = [];
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail.push(m); console.log(`  ✗ ${m}`); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const cap = async (p: PublicKey) => parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data)).capital;
async function waitSlot() { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) <= s) await sleep(300); }

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  // high maxStaleness; mm/im 500/1000; maxMove 400 (4%/update); start $100
  const params: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  // open: Long 5 @ $100 (notional $500, IM $50); Short 5 @ $100
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 5n * POS_SCALE })], [oL, oS], false);
  const capL0 = await cap(pL), capS0 = await cap(pS);
  console.log(`opened Long5/Short5 @ $100: L.cap=${Number(capL0) / 1e6} S.cap=${Number(capS0) / 1e6}`);

  // price +1% -> $101 (a056eee maxMove=100bps). settle loser (short) first so its loss backs the winner.
  await waitSlot();
  await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: 101n * POS_SCALE })], [oracle]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pS })]);
  await send([refreshLeg(P, { dex, market: mkt, portfolio: pL })]);
  const capL1 = await cap(pL), capS1 = await cap(pS);
  const longGain = Number(capL1 - capL0) / 1e6, shortLoss = Number(capS0 - capS1) / 1e6;
  console.log(`after +1% ($100->$101): L.cap=${Number(capL1) / 1e6} (Δ+${longGain}) S.cap=${Number(capS1) / 1e6} (Δ-${shortLoss})`);
  // expected PnL = qty(5) * Δprice($1) = $5
  ok(Math.abs(longGain - 5) <= 0.5, `LONG profits ~$5 on +1% (qty 5 * $1) — got +$${longGain}`);
  ok(Math.abs(shortLoss - 5) <= 0.5, `SHORT loses ~$5 (matching) — got -$${shortLoss}`);
  ok(Math.abs(longGain - shortLoss) <= 0.01, `zero-sum: long gain == short loss`);

  // keep pushing price up 1%/step; the SHORT (loser) should become liquidatable before the long
  let price = 101n * POS_SCALE, liqd = false;
  for (let i = 0; i < 40 && !liqd; i++) {
    await waitSlot();
    price = (price * 101n) / 100n;
    await send([updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price })], [oracle]);
    await send([refreshLeg(P, { dex, market: mkt, portfolio: pS })]).catch(() => {});
    // short liquidatable?
    try {
      const tx = new Transaction().add(liquidate(P, V, { market: mkt, portfolio: pS, liquidatorToken: fTok }));
      tx.feePayer = funder.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(funder);
      const sim = await conn.simulateTransaction(tx);
      if (!sim.value.err) { await send([liquidate(P, V, { market: mkt, portfolio: pS, liquidatorToken: fTok })]); liqd = true; console.log(`   SHORT liquidated at price $${Number(price) / 1e6}`); }
    } catch { /* */ }
  }
  ok(liqd, "underwater SHORT becomes liquidatable as price rises (margin enforced)");
  // and the LONG stays healthy (not liquidatable) at that price
  const tx = new Transaction().add(liquidate(P, V, { market: mkt, portfolio: pL, liquidatorToken: fTok }));
  tx.feePayer = funder.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(funder);
  const simL = await conn.simulateTransaction(tx);
  ok(simL.value.err !== null, "healthy LONG cannot be liquidated at the same price");

  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const vaultBal = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  ok(d.vaultBalance === vaultBal, `conservation V==SPL (${Number(d.vaultBalance) / 1e6}==${Number(vaultBal) / 1e6})`);

  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) { console.log("FAILURES:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("FUNCTIONALLY CORRECT: directional PnL, zero-sum settlement, and margin-based liquidation all behave as a perp DEX should.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
