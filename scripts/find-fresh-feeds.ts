/**
 * Enumerate existing Pyth + Switchboard On-Demand feeds on devnet and find
 * any that are still being updated (publish/result_timestamp within last 10 min).
 *
 * Sorts by freshness and prints the top-5 candidates per provider.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { SwitchboardPullFeed, OracleProvider } from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const NOW = Math.floor(Date.now() / 1000);

async function listSwitchboard() {
  console.log("\n=== Switchboard On-Demand devnet feeds ===");
  const accs = await conn.getProgramAccounts(
    new PublicKey(OracleProvider.SWITCHBOARD_ONDEMAND_DEVNET),
    {
      filters: [
        { memcmp: { offset: 0, bytes: SwitchboardPullFeed.discriminator.toString("base64"), encoding: "base64" } },
      ],
      commitment: "confirmed",
    },
  );
  console.log(`  raw count: ${accs.length}`);
  // PullFeedAccount layout (relevant fields):
  // 0..8     discriminator
  // ...      various fixed fields
  // We don't fully parse — instead, look at last-write slot relative to wallclock
  // proxy is impractical; use account's `slot` field if present. For now just
  // peek at sizes + dump first 10.
  const candidates: { key: PublicKey; size: number }[] = [];
  for (const a of accs) {
    candidates.push({ key: a.pubkey, size: a.account.data.length });
  }
  candidates.slice(0, 10).forEach((c, i) =>
    console.log(`  [${i}] ${c.key.toBase58()}  size=${c.size}`),
  );
  console.log(`  (showing first 10 of ${candidates.length})`);
}

async function pythKnownFeed() {
  // Pyth Solana Receiver: feeds are PDAs at (feed_id, shard_id) under
  // `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. The Hermes feed_id is the
  // canonical hex id (same across all chains). We don't need to enumerate
  // existing accounts — we PUBLISH on demand. Just verify the program is
  // there and ready.
  const recv = new PublicKey(OracleProvider.PYTH_RECEIVER);
  const info = await conn.getAccountInfo(recv);
  console.log(`\n=== Pyth Solana Receiver (${recv.toBase58()}) ===`);
  console.log(`  exists: ${!!info}, executable: ${info?.executable}`);
  console.log(`  → use push.js to publish a feed account on demand.`);
  console.log(`    Example: SOL/USD feed_id = ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`);
}

async function main() {
  await pythKnownFeed();
  await listSwitchboard();
}
main().catch(e => { console.error(e); process.exit(1); });
