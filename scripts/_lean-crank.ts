/** Permissionlessly crank the live bounty market's oracle from the Pyth SOL/USD feed. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import { LEAN_MAINNET, adapterCrank, parseMarket } from "../src/lean/index.js";

const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");
const P = LEAN_MAINNET.percolator, O = LEAN_MAINNET.oracleAdapter;
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const CFG = new PublicKey("4P2D6KUS7AcpfDniZrFJvNbw55Mh3qxo95pMW1CE5KZL");
const MARKET = new PublicKey("BhYaG2JYRHGrLpWs85TroedmkcG7toX1Ly5YbG1FDZHH");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const u = (n: bigint) => (Number(n) / 1e6).toFixed(4);

async function freshFeed() {
  const r = await conn.getProgramAccounts(RECEIVER, { commitment: "confirmed", filters: [{ memcmp: { offset: 41, bytes: bs58.encode(Buffer.from(SOL_FEED, "hex")) } }] });
  let b: any = null; const now = Math.floor(Date.now() / 1000);
  for (const { pubkey, account } of r) { const d = account.data; if (d.length < 134 || d[40] !== 1) continue; const pr = d.readBigInt64LE(73), ex = d.readInt32LE(89), age = now - Number(d.readBigInt64LE(93)); if (pr <= 0n) continue; const sh = ex + 6; const e6 = sh >= 0 ? pr * 10n ** BigInt(sh) : pr / 10n ** BigInt(-sh); if (!b || age < b.age) b = { addr: pubkey, e6, age }; }
  return b;
}
async function send(ix: TransactionInstruction) {
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(ix), [funder], { commitment: "confirmed" }); } catch (e) { const m = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|rate|block height|timed out/i.test(m)) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; } throw e; } }
}
const mark = async () => (await parseMarket(Buffer.from((await conn.getAccountInfo(MARKET))!.data))).markPrice;

async function main() {
  const rounds = parseInt(process.argv[2] ?? "3");
  const f = await freshFeed();
  console.log(`feed ${f.addr.toBase58()} = $${u(f.e6)} (age ${f.age}s) | mark before = $${u(await mark())}`);
  for (let i = 0; i < rounds; i++) {
    try { const sig = await send(adapterCrank(O, { cfg: CFG, market: MARKET, feed: f.addr, percolator: P })); console.log(`crank ${i + 1}: mark=$${u(await mark())}  (${sig.slice(0, 12)}…)`); }
    catch (e) { console.log(`crank ${i + 1} skipped: ${String((e as Error).message ?? e).slice(0, 90)}`); break; }
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`mark after = $${u(await mark())} (target $${u(f.e6)})`);
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
