/**
 * Dump raw bytes for multiple accounts to find the pattern
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;

async function main() {
  const data = await fetchSlab(connection, SLAB);

  for (const idx of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    console.log(`\n=== Account index ${idx} (base ${base}) ===`);

    // Raw first 112 bytes
    console.log('Raw bytes:');
    for (let i = 0; i < 112; i += 16) {
      const hex = data.subarray(base + i, base + i + 16).toString('hex');
      const formatted = hex.match(/.{1,2}/g)?.join(' ') || '';
      console.log(`  ${i.toString().padStart(3)}: ${formatted}`);
    }

    // Key interpretations
    const accountId = data.readBigUInt64LE(base + 0);
    const capitalLo = data.readBigUInt64LE(base + 8);
    const capitalHi = data.readBigUInt64LE(base + 16);
    const capital = (capitalHi << 64n) | capitalLo;
    const kind = data.readUInt8(base + 24);
    const pnlLo = data.readBigUInt64LE(base + 32);
    const pnlHi = data.readBigUInt64LE(base + 40);
    const positionLo = data.readBigUInt64LE(base + 80);
    const positionHi = data.readBigUInt64LE(base + 88);
    const entryPrice = data.readBigUInt64LE(base + 96);

    console.log('Interpreted values:');
    console.log(`  account_id(0): ${accountId}`);
    console.log(`  capital(8-23): lo=${capitalLo}, hi=${capitalHi}, combined=${capital}`);
    console.log(`  kind(24): ${kind}`);
    console.log(`  pnl(32-47): lo=${pnlLo}, hi=${pnlHi}`);
    console.log(`  position(80-95): lo=${positionLo}, hi=${positionHi}`);
    console.log(`  entry_price(96): ${entryPrice}`);

    // Check if this looks like a valid account
    const hasPosition = positionLo !== 0n || positionHi !== 0n;
    const hasReasonableEntry = entryPrice > 1000n && entryPrice < 100000n;
    console.log(`  looks_valid: hasPosition=${hasPosition}, reasonableEntry=${hasReasonableEntry}`);
  }
}

main().catch(console.error);
