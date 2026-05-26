import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { parseMarketGroup } from "../src/v16/parsers.js";
import { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN, V16_MAX_MARKET_SLOTS } from "../src/v16/constants.js";
const RPC = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`,"utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const PROG = "4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi";
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
const eo = (a: number) => MARKET_GROUP_OFF + MG.asset_slots + a * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
(async () => {
  for (const [label, addr] of [["LIVE  BhkMic5g", "BhkMic5gHLjj5Uxkg6rBBXofUzeTZVwmV4uFzfhwtgQw"], ["OLD   8oYjDr2", "8oYjDr2Rt6BCuBvwaUGx7gLnzQbkuARTtrQr7DijAHn7"]]) {
    const ai = await conn.getAccountInfo(new PublicKey(addr), "confirmed");
    if (!ai) { console.log(`${label}: <no account>\n`); continue; }
    const b = Buffer.from(ai.data);
    const mg: any = parseMarketGroup(b);
    let sum = 0n;
    const rows: string[] = [];
    for (let a = 0; a < V16_MAX_MARKET_SLOTS; a++) {
      const o = eo(a);
      const bl = u128(b,o+499)-u128(b,o+531), bs = u128(b,o+515)-u128(b,o+547);
      sum += bl + bs;
      if (bl !== 0n || bs !== 0n) rows.push(`slot ${a}: long_rem=${sol(bl)} short_rem=${sol(bs)}`);
    }
    console.log(`${label}  (${addr})`);
    console.log(`   owner=${ai.owner.toBase58()===PROG?"4m3ip… ✅":ai.owner.toBase58()}  size=${b.length}  rent=${(ai.lamports/1e9).toFixed(4)} SOL`);
    console.log(`   insurance=${sol(BigInt(mg.insurance))}  Σbudget_remaining=${sol(sum)}`);
    console.log(`   truly-activated asset slots: [${(mg.assets ?? []).map((a:any)=>`#${a.index}(lc=${a.lifecycle})`).join(", ")}]`);
    rows.forEach(r => console.log(`     ${r}`));
    console.log(`   invariant Σ≤insurance : ${sum<=BigInt(mg.insurance)?"HOLDS ✅ (healthy / recoverable)":"VIOLATED 🚨 (BRICKED)"}\n`);
  }
})().catch(e => { console.error(e.message||e); process.exit(1); });
