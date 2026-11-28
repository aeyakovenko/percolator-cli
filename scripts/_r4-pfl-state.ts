/** Read-only: prize portfolios full state + same-slot conservation. */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { parsePortfolio, parseDex, parseMarket, deriveDexVault } from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync("lean-mainnet-r4.json", "utf8"));
const P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MKT = new PublicKey(m.market);
const U = (n: bigint) => (Number(n) / 1e6).toFixed(6);
(async () => {
  const keys = [DEX, deriveDexVault(P, DEX)[0], MKT, new PublicKey(m.prizes.userLong), new PublicKey(m.counterpartyShort)];
  const r = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
  const d: any = parseDex(Buffer.from(r.value[0]!.data)); const spl = Buffer.from(r.value[1]!.data).readBigUInt64LE(64);
  const mk: any = parseMarket(Buffer.from(r.value[2]!.data));
  console.log(`slot ${r.context.slot}: V=${U(d.vaultBalance)} SPL=${U(spl)} equal=${d.vaultBalance === spl}  mark ${Number(mk.markPrice) / 1e6}`);
  for (const [name, i] of [["prize-3 long", 3], ["counterparty short", 4]] as const) {
    const p: any = parsePortfolio(Buffer.from(r.value[i]!.data));
    const pnl = p.legs.reduce((a: bigint, l: any) => a + l.posPnl, 0n);
    console.log(`${name}: capital ${U(p.capital)} locked ${U(p.totalLockedMm)} posPnl ${U(pnl)} => value ${U(p.capital + p.totalLockedMm + pnl)}  legs ${JSON.stringify(p.legs.map((l: any) => ({ side: l.side, basis: String(l.rawBasis), entryPrice: String(l.entryPrice ?? ""), pnl: String(l.posPnl) })))}`);
  }
})();
