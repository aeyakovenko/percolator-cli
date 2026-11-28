/** READ-ONLY mainnet scan for the 887ba02 -> 8774e86 in-place upgrade decision. Sends NO transaction (it never loads a keypair).
 *  For every account of the live round-4 percolator program it checks the bytes that 8774e86 gives a NEW meaning:
 *    Market byte 5  (was reserved padding, becomes `deficitMode`)  -> must be 0 on every market;
 *    Leg byte 3     (was padding, becomes `postOracle`)            -> must be 0 on every active leg;
 *  and reports the state the new rules key on: insFronted (share-minting insurance deposits reject while > 0),
 *  fundingCfg + rewardBps (CreateMarket now rejects funding with rewardBps 10000; existing markets are grandfathered),
 *  and how many portfolios are non-flat / multi-leg (they need trailing Market accounts after the upgrade). */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { LEAN_MAINNET, MAGIC, MARKET_SIZE, PORTFOLIO_SIZE, DEX_SIZE, PflOff, MAX_LEGS, parseMarket, parsePortfolio, parseDex, openLegs } from "../src/lean/index.js";

const rpc = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").replace(/\s/g, "")}`;
const conn = new Connection(rpc, "confirmed");
const P = LEAN_MAINNET.percolator;
const U = (n: bigint) => (Number(n) / 1e6).toFixed(6);
let bad = 0;
const need = (c: boolean, s: string) => { if (!c) { bad++; console.log(`  PROBLEM ${s}`); } };

async function main() {
  const accs = await conn.getProgramAccounts(P, { commitment: "confirmed" });
  const slot = await conn.getSlot("confirmed");
  const pi = await conn.getAccountInfo(P);
  const pd = new PublicKey(pi!.data.subarray(4, 36));
  const pdi = await conn.getAccountInfo(pd);
  console.log(`mainnet percolator ${P.toBase58()}: ${accs.length} accounts @~slot ${slot}; programdata ${pd.toBase58()} ${pdi!.data.length} B (max program len ${pdi!.data.length - 45} B; candidate 8774e86 = 91104 B)`);
  need(pdi!.data.length - 45 >= 91104, "programdata too small for the candidate");
  let nM = 0, nP = 0, nonFlat = 0, multi = 0, bound = 0, other = 0;
  for (const a of accs) {
    const b = Buffer.from(a.account.data); const k = a.pubkey.toBase58();
    const magic = b.length >= 4 ? b.readUInt32LE(0) : 0;
    if (magic === MAGIC.MARKET && b.length === MARKET_SIZE) {
      nM++; const m = parseMarket(b);
      need(b[5] <= 1, `market ${k}: byte 5 = ${b[5]} (deficitMode must be 0/1; must be 0 before the 8774e86 upgrade)`);
      console.log(`  market ${k} id=${m.marketId} ${m.statusName} byte5=${b[5]} mark=$${U(m.markPrice)} oracleAge=${BigInt(slot) - m.lastOracleSlot} insurance=$${U(m.insurance)} insFronted=${m.insFronted} realizedPool=${m.realizedPool} totalPosPnl=${m.totalPosPnl} oiL/S=${m.oiLong}/${m.oiShort} rawL/S=${m.rawBasisLong}/${m.rawBasisShort} adlL/S=${m.adlLong}/${m.adlShort} rewardBps=${m.rewardBps} rewardAccrued=$${U(m.rewardAccrued)} funding=${JSON.stringify(m.funding)} lastRampSlot=${m.lastRampSlot}`);
    } else if (magic === MAGIC.PORTFOLIO && b.length === PORTFOLIO_SIZE) {
      nP++; const p = parsePortfolio(b); const open = openLegs(p);
      if (open.length) nonFlat++; if (open.length > 1) multi++; if (!p.matcherCtx.equals(PublicKey.default)) bound++;
      for (let i = 0; i < MAX_LEGS; i++) {
        const base = PflOff.headerSize + i * PflOff.legStride;
        if (b[base] === 0) continue;
        need(b[base + 3] <= 1, `portfolio ${k} leg ${i}: byte 3 = ${b[base + 3]} (postOracle must be 0/1; must be 0 before the 8774e86 upgrade)`);
        need(b[base + 2] === 0, `portfolio ${k} leg ${i}: bankruptMark = ${b[base + 2]}`);
      }
      console.log(`  portfolio ${k} owner=${p.owner.toBase58().slice(0, 8)}… capital=$${U(p.capital)} locked=$${U(p.totalLockedMm)} legs=${p.legs.map((l) => `${l.sideName}:${l.rawBasis}@mkt${l.marketId}(pnl ${l.posPnl})`).join(",") || "-"}${p.matcherCtx.equals(PublicKey.default) ? "" : " [matcher-bound]"}`);
    } else if (magic === MAGIC.DEX && b.length === DEX_SIZE) {
      const d = parseDex(b);
      console.log(`  dex ${k} V=$${U(d.vaultBalance)} C=$${U(d.totalCapital)} I=$${U(d.totalInsurance)} R=$${U(d.totalResidual)} S=$${U(d.totalSurplus)} Rew=$${U(d.totalRewards)} sumOK=${d.vaultBalance === d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards}`);
    } else if (magic === MAGIC.INSURANCE && b.length === 88) {
      // 55c167f: bytes 4..7 (zero padding) become lastDepositBucket; a non-zero value there would be read as a deposit
      // bucket (a huge one would block WithdrawInsurance-with-OI until the market is empty).
      const bucket = b.readUInt32LE(4);
      need(bucket <= (slot >> 4), `insReceipt ${k}: bytes 4..7 = ${bucket} > current bucket ${slot >> 4}`);
      console.log(`  insReceipt ${k} owner=${new PublicKey(b.subarray(16, 48)).toBase58().slice(0, 8)}… market=${new PublicKey(b.subarray(48, 80)).toBase58().slice(0, 8)}… shares=${b.readBigUInt64LE(80)} bytes4..7=${bucket}`);
    } else other++;
  }
  console.log(`markets ${nM}, portfolios ${nP} (non-flat ${nonFlat}, multi-leg ${multi}, matcher-bound ${bound}), other accounts ${other}`);
  console.log(bad === 0 ? "MAINNET SCAN: no account carries an invalid value in the re-purposed padding (Market byte 5 / Leg byte 3 / InsReceipt bytes 4..7)" : `MAINNET SCAN: ${bad} PROBLEM(S)`);
  if (bad) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", String(e).replace(/api-key=[^&\s"']+/g, "api-key=***").slice(0, 400)); process.exit(1); });
