/**
 * Enumerate Chainlink Store feeds on devnet and find ones being actively
 * updated. The Chainlink Store program is at HEvSK...JWHny on devnet.
 *
 * Account layout (Transmissions):
 *   0..8   discriminator [96, 179, 69, 66, 128, 129, 73, 117]
 *   8..40  description bytes (UTF-8, padded with zeros) — used to identify feed
 *   ...    version, state, latestRoundId, then a ring buffer of round data
 *
 * For our purpose, we just want feed accounts whose latest round was updated
 * recently. Chainlink Store stores rounds as (slot, timestamp, answer) tuples
 * in a ring buffer keyed by round_id.
 */
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const STORE = new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const conn = new Connection(RPC, "confirmed");

const DISC = Buffer.from([96, 179, 69, 66, 128, 129, 73, 117]);

async function main() {
  console.log("enumerating Chainlink Store feed accounts on devnet...");
  const accs = await conn.getProgramAccounts(STORE, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: DISC.toString("base64"), encoding: "base64" } }],
  });
  console.log(`candidates: ${accs.length}`);
  if (accs.length === 0) return;

  const nowTs = Math.floor(Date.now() / 1000);
  const currentSlot = await conn.getSlot("confirmed");

  type Row = { pk: PublicKey; size: number; desc: string; latestSlot: number; latestTs: number; latestAnswer: bigint };
  const rows: Row[] = [];

  for (const a of accs) {
    const d = a.account.data;
    if (d.length < 200) continue;
    // Description is typically at offset ~8 padded with NULs.
    let desc = "";
    for (let i = 8; i < 8 + 96 && i < d.length; i++) {
      const c = d[i];
      if (c === 0) break;
      if (c >= 32 && c <= 126) desc += String.fromCharCode(c);
    }
    // Try a few plausible layouts: look for the most recent slot/timestamp
    // pair. Chainlink Store v1 ring entries are 16-byte (slot u64 + answer i128?)
    // — we'll just scan for the largest u64 that resembles a slot.
    let latestSlot = 0;
    let latestTs = 0;
    let latestAnswer = 0n;
    // Heuristic: scan the last 8KB of the account for the largest u64 close to currentSlot.
    const start = Math.max(0, d.length - 8 * 1024);
    for (let off = start; off + 16 <= d.length; off += 8) {
      const v = d.readBigUInt64LE(off);
      if (v > 0n && v <= BigInt(currentSlot) && Number(v) > latestSlot) {
        latestSlot = Number(v);
        // Timestamp is usually adjacent (i64).
        if (off + 16 <= d.length) latestTs = Number(d.readBigInt64LE(off + 8));
      }
    }
    rows.push({ pk: a.pubkey, size: d.length, desc, latestSlot, latestTs, latestAnswer });
  }

  rows.sort((a, b) => b.latestSlot - a.latestSlot);
  console.log("\nTop 15 by latest slot:");
  for (const r of rows.slice(0, 15)) {
    const slotLag = r.latestSlot > 0 ? (currentSlot - r.latestSlot).toString() : "?";
    const ageS = r.latestTs > 0 ? (nowTs - r.latestTs).toString() : "?";
    console.log(`  ${r.pk.toBase58()}  size=${r.size}  slotLag=${slotLag}  age=${ageS}s  desc="${r.desc}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
