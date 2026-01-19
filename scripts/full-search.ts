/**
 * Full search of entire slab for capital value
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  console.log('Slab length:', data.length);

  // Search for 0x5f084bb = 99877051
  // In little-endian: bb 84 f0 05
  console.log('\n=== Searching ENTIRE slab for 0x5f084bb (99877051) ===');

  let found = false;
  for (let i = 0; i < data.length - 4; i++) {
    const val = data.readUInt32LE(i);
    if (val === 99877051) {
      console.log(`Found at offset ${i}`);
      found = true;
    }
  }
  if (!found) {
    console.log('NOT FOUND anywhere in slab!');
  }

  // Also search for common capital values (~0.1 SOL = 100000000)
  console.log('\n=== Searching for values around 100M (0.1 SOL) ===');
  for (let i = 0; i < data.length - 8; i++) {
    const val = data.readBigUInt64LE(i);
    if (val >= 90000000n && val <= 110000000n) {
      console.log(`Found ${val} at offset ${i}`);
    }
  }

  // Check if account 5 might have been liquidated/zeroed
  console.log('\n=== All non-zero u64 values in account 5 area ===');
  const base5 = 328 + 95256 + 5 * 248;
  for (let i = 0; i < 248; i += 8) {
    const val = data.readBigUInt64LE(base5 + i);
    if (val !== 0n) {
      console.log(`  offset ${i}: ${val} (0x${val.toString(16)})`);
    }
  }
}

main().catch(console.error);
