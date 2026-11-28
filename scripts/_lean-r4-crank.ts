/** Lazy BTC oracle keeper for the mainnet round-4 bounty (9b45ad1; built-in funding accrues on each push, fundE6 stays 0). Reads Coinbase BTC/USD and pushes it to
 *  the market's pushed oracle via UpdateOracle — ONLY when the oracle is within 1/3 of its staleness
 *  window of expiring (minimal SOL). `lazy` arg = skip if fresh.
 *  The pushed price is clamped by src/lean/oracle-clamp.ts, which mirrors handleUpdateOracle exactly:
 *  maxAllowed = floor(mark * maxMoveBps / 10000) with maxMoveBps read from the Market (halved at dt == 1),
 *  and the keeper moves at most (maxAllowed >> 1) - 1 per push — below the "saturated ramp" threshold that
 *  pauses I_m fronting (75% on deployed 9b45ad1, 50% in the pending source) and leaving > 50% of the budget to funding.
 *  Env (defaults = the live mainnet round-4 keeper): LEAN_MANIFEST (manifest json), ORACLE_KEYPAIR
 *  (oracle authority keypair), LEAN_RPC_URL (RPC endpoint; default mainnet Helius). */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { updateOracle, parseMarket, clampPush, maxAllowedMove, stampsRamp } from "../src/lean/index.js";

const HOME = process.env.HOME;
const mani = JSON.parse(fs.readFileSync(process.env.LEAN_MANIFEST ?? `${HOME}/percolator-cli/lean-mainnet-r4.json`, "utf8"));
const rpc = process.env.LEAN_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(rpc, "confirmed");
const P = new PublicKey(mani.percolator);
const MARKET = new PublicKey(mani.market);
const oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ORACLE_KEYPAIR ?? `${HOME}/.config/solana/lean-mainnet-r4-oracle.json`, "utf8"))));
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));
const u = (n: bigint) => (Number(n) / 1e6).toFixed(2);

async function btc(): Promise<bigint> {
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const j: any = await r.json();
  const px = Math.round(parseFloat(j?.data?.amount) * 1e6);
  if (!Number.isSafeInteger(px) || px <= 0) throw new Error(`bad BTC price from Coinbase: ${JSON.stringify(j).slice(0, 80)}`);
  return BigInt(px);
}
async function main() {
  const lazy = process.argv.includes("lazy");
  const m = parseMarket(Buffer.from((await conn.getAccountInfo(MARKET))!.data));
  if (m.statusName !== "Active") { console.log(`market ${m.statusName}; skip`); return; }
  const slot = BigInt(await conn.getSlot("confirmed"));
  const age = slot >= m.lastOracleSlot ? slot - m.lastOracleSlot : 0n;
  if (lazy && age < m.maxStaleness / 3n) { console.log(`fresh: age=${age}/${m.maxStaleness} (< ${m.maxStaleness / 3n}); skip`); return; }
  // Clamp toward the live BTC target with the program's own rule. `age` is a lower bound of the landing
  // dt (the tx lands after `slot`), so age <= 1 conservatively takes the dt == 1 half step.
  const target = await btc();
  const push = clampPush(m.markPrice, target, m.maxMoveBps, age);
  const diff = push >= m.markPrice ? push - m.markPrice : m.markPrice - push;
  const maxAllowed = maxAllowedMove(m.markPrice, m.maxMoveBps, age);
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(updateOracle(P, { market: MARKET, oracleAuth: oracle.publicKey, price: push })), [funder, oracle], { commitment: "confirmed" });
  console.log(`cranked BTC: mark $${u(m.markPrice)} -> $${u(push)} (target $${u(target)}, age ${age}, step ${diff}/${maxAllowed} maxMoveBps=${m.maxMoveBps}${stampsRamp(maxAllowed, diff) ? " RAMP" : ""}) ${sig.slice(0, 12)}…`);
}
main().catch(e => { console.error(String(e).replace(/api-key=[^&\s"']+/g, "api-key=***").slice(0, 200)); process.exit(1); });
