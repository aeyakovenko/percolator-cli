/**
 * Walk Switchboard On-Demand devnet feeds and find ones with a recent
 * lastUpdateTimestamp — i.e. someone is actively pushing them.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor-31";
import { Keypair } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import * as fs from "fs";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const program = await sb.AnchorUtils.loadProgramFromConnection(conn, new Wallet(kp));
  const PROG = program.programId;

  // PullFeed discriminator (from common SDK).
  const disc = Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]);

  console.log("enumerating Switchboard On-Demand pull feeds on devnet…");
  const accs = await conn.getProgramAccounts(PROG, {
    filters: [{ memcmp: { offset: 0, bytes: disc.toString("base64"), encoding: "base64" } }],
    commitment: "confirmed",
  });
  console.log(`total candidates: ${accs.length}`);

  const nowTs = Math.floor(Date.now() / 1000);
  const currentSlot = await conn.getSlot("confirmed");

  type Row = { pk: PublicKey; lastTs: number; lastSlot: number; value: bigint; name: string };
  const rows: Row[] = [];

  for (const a of accs) {
    try {
      const decoded = (program.coder.accounts as any).decode("pullFeedAccountData", a.account.data);
      const lastTs = Number((decoded.lastUpdateTimestamp ?? decoded.last_update_timestamp ?? 0n));
      const lastSlot = Number((decoded.result?.slot ?? 0n));
      const value = BigInt(decoded.result?.value ?? 0n);
      const name = Buffer.from(decoded.name ?? []).toString("utf8").replace(/\0+/g, "").trim();
      rows.push({ pk: a.pubkey, lastTs, lastSlot, value, name });
    } catch (_e) { /* skip undecodable */ }
  }

  // Sort by lastTs desc.
  rows.sort((a, b) => b.lastTs - a.lastTs);
  const fresh = rows.filter(r => r.lastTs > 0 && (nowTs - r.lastTs) < 600);
  console.log(`fresh (<10min): ${fresh.length}`);
  console.log("\nTop 15 most-recently-updated feeds:");
  for (const r of rows.slice(0, 15)) {
    const ageS = r.lastTs > 0 ? (nowTs - r.lastTs).toString() : "?";
    const slotLag = r.lastSlot > 0 ? (currentSlot - r.lastSlot).toString() : "?";
    console.log(`  ${r.pk.toBase58()}  age=${ageS}s slotLag=${slotLag}  v=${r.value}  name="${r.name}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
