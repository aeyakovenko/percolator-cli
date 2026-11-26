/** Lazy BTC oracle keeper for the mainnet round-3 bounty. Reads Coinbase BTC/USD and pushes it to
 *  the market's pushed oracle via UpdateOracle — ONLY when the oracle is within 1/3 of its staleness
 *  window of expiring (minimal SOL). 1%-clamped per push (maxMoveBps=100). `lazy` arg = skip if fresh. */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { updateOracle, parseMarket } from "../src/lean/index.js";

const mani = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/lean-mainnet-r3.json`, "utf8"));
const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");
const P = new PublicKey(mani.percolator);
const MARKET = new PublicKey(mani.market);
const oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/lean-mainnet-r3-oracle.json`, "utf8"))));
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const u = (n: bigint) => (Number(n) / 1e6).toFixed(2);

async function btc(): Promise<bigint> {
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const j: any = await r.json();
  return BigInt(Math.round(parseFloat(j.data.amount) * 1e6));
}
async function main() {
  const lazy = process.argv.includes("lazy");
  const m = parseMarket(Buffer.from((await conn.getAccountInfo(MARKET))!.data));
  if (m.statusName !== "Active") { console.log(`market ${m.statusName}; skip`); return; }
  const slot = BigInt(await conn.getSlot("confirmed"));
  const age = slot >= m.lastOracleSlot ? slot - m.lastOracleSlot : 0n;
  if (lazy && age < m.maxStaleness / 3n) { console.log(`fresh: age=${age}/${m.maxStaleness} (< ${m.maxStaleness / 3n}); skip`); return; }
  // 1%-clamp the pushed price toward the live BTC target
  const target = await btc();
  const maxUp = (m.markPrice * 101n) / 100n, maxDn = (m.markPrice * 99n) / 100n;
  const push = target > maxUp ? maxUp : target < maxDn ? maxDn : target;
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(updateOracle(P, { market: MARKET, oracleAuth: oracle.publicKey, price: push })), [funder, oracle], { commitment: "confirmed" });
  console.log(`cranked BTC: mark $${u(m.markPrice)} -> $${u(push)} (target $${u(target)}, age ${age}) ${sig.slice(0, 12)}…`);
}
main().catch(e => { console.error(String(e).slice(0, 200)); process.exit(1); });
