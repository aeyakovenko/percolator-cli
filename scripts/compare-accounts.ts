/**
 * Compare account structures to find the mismatch
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

  console.log('=== Comparing account data patterns ===\n');

  // For valid accounts (2-4), let's see what offset has ~0.1 SOL capital
  // Capital should be around 100,000,000 (0.1 SOL * 1e9)

  for (const idx of [2, 3, 4, 5]) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    console.log(`\n--- Account ${idx} (base ${base}) ---`);

    // Search within this account for values around 100M
    console.log('Values around 100M (potential capital):');
    for (let i = 0; i < ACCOUNT_SIZE - 8; i += 8) {
      const val = data.readBigUInt64LE(base + i);
      if (val >= 90000000n && val <= 500000000n) {
        console.log(`  offset ${i}: ${val} (${(Number(val) / 1e9).toFixed(4)} SOL)`);
      }
    }

    // Search for small positive values (potential account_id)
    console.log('Small positive values (potential account_id):');
    for (let i = 0; i < ACCOUNT_SIZE - 8; i += 8) {
      const val = data.readBigUInt64LE(base + i);
      if (val > 0n && val < 100n) {
        console.log(`  offset ${i}: ${val}`);
      }
    }

    // Show bytes 0-31 in hex for comparison
    console.log('First 32 bytes:');
    console.log(`  ${data.subarray(base, base + 32).toString('hex')}`);
  }

  // Check if account 5's garbage might actually be signed
  const base5 = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 5 * ACCOUNT_SIZE;
  const val0 = data.readBigUInt64LE(base5);
  const signed = val0 > 0x7FFFFFFFFFFFFFFFn ? BigInt.asIntN(64, val0) : val0;
  console.log(`\n\nAccount 5 offset 0 as signed: ${signed}`);

  // Check what -1132339 might mean
  // -1132339 = -(1132339) = -(0x114733)
  console.log(`If interpreted as delta from something:`);
  console.log(`  0x114733 = ${0x114733}`);  // 1132339
}

main().catch(console.error);
