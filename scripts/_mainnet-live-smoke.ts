/** De-minimis live smoke on the mainnet bounty market from LEAN_MANIFEST (default round 4). Does not touch prizes.
 *  Conservation is read ATOMICALLY (DEX + vault in one getMultipleAccounts, same slot). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import * as fs from "fs";
import { PORTFOLIO_SIZE, TRADE_MODE, initPortfolio, depositCollateral, withdrawCollateral, trade, updateOracle, withLegRefresh,
  deriveDexVault, parseDex, parseMarket, parsePortfolio, type VaultAccounts } from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync(process.env.LEAN_MANIFEST ?? "lean-mainnet-r4.json", "utf8"));
const P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MKT = new PublicKey(m.market), USDC = new PublicKey(m.usdc);
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/lean-mainnet-r${m.round ?? 4}-oracle.json`, "utf8"))));
const V: VaultAccounts = { dex: DEX, mint: USDC, vault: deriveDexVault(P, DEX)[0] };
const U = (n: bigint) => (Number(n) / 1e6).toFixed(4);
let ok = 0; const fails: string[] = [];
const check = (c: boolean, s: string) => { if (c) { ok++; console.log("  OK " + s); } else { fails.push(s); console.log("  FAIL " + s); } };
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) {
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...s], { commitment: "confirmed" }); } catch (e) { const t = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|rate|block height|timed out|not found/i.test(t)) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; } throw e; } }
}
async function newAcc(sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: P })], [kp]); return kp.publicKey; }
async function state(tag: string) {
  const r = await conn.getMultipleAccountsInfoAndContext([DEX, V.vault, MKT, new PublicKey(m.prizes.vaultPortfolio)], "confirmed");
  const d = parseDex(Buffer.from(r.value[0]!.data)), spl = Buffer.from(r.value[1]!.data).readBigUInt64LE(64);
  const mk = parseMarket(Buffer.from(r.value[2]!.data)), vault = Buffer.from(r.value[3]!.data).readBigUInt64LE(88);
  const sum = d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards;
  console.log(`[${tag} @slot ${r.context.slot}] V=$${U(d.vaultBalance)} SPL=$${U(spl)} sum=$${U(sum)} | insurance=$${U(mk.insurance)} vault=$${U(vault)} | mark=$${U(mk.markPrice)} premiumE6=${mk.premiumE6} funding=${JSON.stringify(mk.funding)}`);
  check(d.vaultBalance === spl && spl === sum, `${tag}: conservation V==SPL==C+I+R+S+Rew (same slot)`);
  check(mk.insurance === 23_000_000n && vault === 23_000_000n, `${tag}: prizes 1+2 intact ($23/$23)`);
  return mk;
}
async function main() {
  const m0 = await state("start");
  const fTok = await getAssociatedTokenAddress(USDC, funder.publicKey);
  const r: any = await (await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot")).json();
  const spot = BigInt(Math.round(parseFloat(r.data.amount) * 1e6)); const up = m0.markPrice + m0.markPrice / 100n, dn = m0.markPrice - m0.markPrice / 100n;
  await send([updateOracle(P, { market: MKT, oracleAuth: oracle.publicKey, price: spot > up ? up : spot < dn ? dn : spot })], [oracle]);
  check(true, "UpdateOracle (built-in funding step, fundE6=0) accepted");
  const pA = await newAcc(PORTFOLIO_SIZE), pB = await newAcc(PORTFOLIO_SIZE);
  for (const p of [pA, pB]) { await send([initPortfolio(P, { dex: DEX, portfolio: p, owner: funder.publicKey })]); await send([depositCollateral(P, V, { portfolio: p, depositor: funder.publicKey, sourceToken: fTok, amount: 1_500_000n })]); }
  const tr = (mode: number) => trade(P, { dex: DEX, market: MKT, longPortfolio: pA, longOwner: funder.publicKey, shortPortfolio: pB, shortOwner: funder.publicKey, mode, qty: 200n });
  await send([tr(TRADE_MODE.OPEN)]);
  check(parsePortfolio(Buffer.from((await conn.getAccountInfo(pA))!.data)).legs.some(l => l.rawBasis > 0n), "Trade OPEN 0.0002 BTC executed");
  await send((await withLegRefresh(conn, [tr(TRADE_MODE.CLOSE)], { percolator: P })).instructions);
  check(!parsePortfolio(Buffer.from((await conn.getAccountInfo(pA))!.data)).legs.some(l => l.rawBasis > 0n), "Trade CLOSE executed (flat)");
  for (const p of [pA, pB]) { const c = parsePortfolio(Buffer.from((await conn.getAccountInfo(p))!.data)).capital; if (c > 0n) await send([withdrawCollateral(P, V, { portfolio: p, owner: funder.publicKey, destToken: fTok, amount: c })]); }
  check(true, "withdrew throwaway collateral back to funder");
  await state("end");
  console.log(`\nLIVE SMOKE: ${ok} ok, ${fails.length} failed`);
}
main().then(() => process.exit(0)).catch(e => { console.error("ERR", String(e).slice(0, 400)); process.exit(1); });
