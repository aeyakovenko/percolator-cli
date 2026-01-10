import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const slab = new PublicKey("9kcSAbQPzqui1uDt7iZAYHmrUB4bVfnAr4UZPmWMc91T");

// From slab.ts - correct values
const ENGINE_OFF = 216;
const ENGINE_ACCOUNTS_OFF = 91160;
const ACCOUNT_SIZE = 248;

async function main() {
  const info = await connection.getAccountInfo(slab);
  if (!info) {
    console.log("Slab not found");
    return;
  }

  // Calculate account 0 base offset
  const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 0 * ACCOUNT_SIZE;
  console.log(`Account 0 starts at offset ${base}`);

  // Dump first 200 bytes of account 0 to understand layout
  console.log("\nFirst 200 bytes of account 0:");
  for (let i = 0; i < 200; i += 8) {
    const bytes = info.data.subarray(base + i, base + i + 8);
    const hex = Buffer.from(bytes).toString("hex");
    const val = bytes.readBigUInt64LE(0);
    // Check if this looks like a pubkey (32 bytes)
    const isPubkeyStart = i % 32 === 0 && i > 0;
    console.log(`  offset ${i.toString().padStart(3)}: ${hex} (u64=${val.toString().padStart(20)})`);
  }

  // According to Rust struct (repr(C)):
  // kind: u8 at offset 0 (1 byte)
  // padding: 7 bytes
  // account_id: u64 at offset 8
  // capital: u128 at offset 16 (needs 16-byte alignment, and 16 is aligned)
  // pnl: i128 at offset 32
  // reserved_pnl: u128 at offset 48
  // warmup_started_at_slot: u64 at offset 64
  // warmup_slope_per_step: u128 at offset 80 (needs 16-byte alignment, but 72 is not!)
  // Actually, warmup_slope might be at 80 due to padding after warmup_started

  console.log("\nParsing with repr(C) Rust layout:");
  console.log(`  kind (byte 0): ${info.data[base + 0]} (0=User, 1=LP)`);
  console.log(`  account_id (u64 @ 8): ${info.data.readBigUInt64LE(base + 8)}`);

  // Read capital as u128
  const capitalLow = info.data.readBigUInt64LE(base + 16);
  const capitalHigh = info.data.readBigUInt64LE(base + 24);
  const capital = capitalLow + (capitalHigh << 64n);
  console.log(`  capital (u128 @ 16): ${capital} = ${Number(capital) / 1e6} tokens`);

  // Read position_size at different offsets to find it
  console.log("\nSearching for owner pubkey (should match admin):");
  const adminPubkey = "A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK";
  for (let off = 120; off < 200; off += 8) {
    const slice = info.data.subarray(base + off, base + off + 32);
    try {
      const pubkey = new (await import("@solana/web3.js")).PublicKey(slice);
      console.log(`  pubkey @ ${off}: ${pubkey.toBase58()}`);
      if (pubkey.toBase58() === adminPubkey) {
        console.log(`    ^^ MATCH! Owner is at offset ${off}`);
      }
    } catch {}
  }
}

main().catch(console.error);
