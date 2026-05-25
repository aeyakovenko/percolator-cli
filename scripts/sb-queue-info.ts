/**
 * Inspect Switchboard On-Demand devnet queue: which oracles are registered,
 * what gateway URLs are active.
 */
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor-31";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

async function main() {
  const program = await sb.AnchorUtils.loadProgramFromConnection(conn, new Wallet(kp));
  const queue = await sb.Queue.loadDefault(program);
  console.log("queue:", queue.pubkey.toBase58());
  const data = await queue.loadData();
  console.log("authority:", data.authority.toBase58());
  const oracleKeys = (data as any).oracleKeys ?? [];
  console.log(`oracles registered: ${oracleKeys.length}`);
  for (const k of oracleKeys.slice(0, 8)) {
    const ok = (k.toBase58 ? k : new (await import("@solana/web3.js")).PublicKey(k)).toBase58?.() ?? String(k);
    console.log("  -", ok);
  }
  // Try to fetch the gateway URLs.
  try {
    const gateways = await queue.fetchGateways();
    console.log(`gateways: ${gateways.length}`);
    for (const g of gateways.slice(0, 8)) {
      console.log("  -", g.gatewayUrl ?? g);
    }
  } catch (e) {
    console.log("fetchGateways failed:", (e as any)?.message ?? e);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
