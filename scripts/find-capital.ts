/**
 * Search for capital value in raw slab data
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

  // Search for capital = 99877051 = 0x5f084bb
  // In little-endian u64: BB 84 F0 05 00 00 00 00
  // Or as part of U128 lo: BB 84 F0 05 00 00 00 00
  console.log('Searching for 0x5f084bb (99877051) pattern...');

  const patterns = [
    Buffer.from([0xbb, 0x84, 0xf0, 0x05]),  // 4-byte match
  ];

  for (let i = 95000; i < 100000; i++) {
    if (data[i] === 0xbb && data[i+1] === 0x84 && data[i+2] === 0xf0 && data[i+3] === 0x05) {
      console.log(`Found at slab offset ${i} (engine offset ${i - ENGINE_OFF})`);
      // Show context
      const base = Math.floor(i / 16) * 16;
      for (let j = base - 16; j <= base + 32; j += 16) {
        const hex = data.subarray(j, j + 16).toString('hex');
        const formatted = hex.match(/.{1,2}/g)?.join(' ') || '';
        const marker = (j <= i && i < j + 16) ? ' <--' : '';
        console.log(`  ${j}: ${formatted}${marker}`);
      }
    }
  }

  // Also search for the pnl value from debug logs: 0x73cd466f5019f3c7
  console.log('\nSearching for pnl lo = 0x73cd466f5019f3c7...');
  // In little-endian: c7 f3 19 50 6f 46 cd 73
  for (let i = 95000; i < 100000; i++) {
    if (data[i] === 0xc7 && data[i+1] === 0xf3 && data[i+2] === 0x19 && data[i+3] === 0x50) {
      console.log(`Found pnl pattern at slab offset ${i} (engine offset ${i - ENGINE_OFF})`);

      // Calculate what offset this would be within an account
      const accountBase = ENGINE_OFF + ENGINE_ACCOUNTS_OFF;
      const relativeOffset = i - accountBase;
      const accountIndex = Math.floor(relativeOffset / ACCOUNT_SIZE);
      const offsetInAccount = relativeOffset % ACCOUNT_SIZE;
      console.log(`  Account index: ${accountIndex}, offset within account: ${offsetInAccount}`);
    }
  }

  // Dump account 5 with different interpretations
  console.log('\n=== Account 5 raw bytes with different offset interpretations ===');
  const base5 = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 5 * ACCOUNT_SIZE;

  console.log(`Account 5 base: ${base5}`);
  console.log('\nIf account_id first (current):');
  console.log(`  offset 0 -> account_id: ${data.readBigUInt64LE(base5)}`);
  console.log(`  offset 8 -> capital lo: ${data.readBigUInt64LE(base5 + 8)}`);
  console.log(`  offset 16 -> capital hi: ${data.readBigUInt64LE(base5 + 16)}`);
  console.log(`  offset 24 -> kind: ${data[base5 + 24]}`);

  console.log('\nIf kind first (old layout):');
  console.log(`  offset 0 -> kind: ${data[base5]}`);
  console.log(`  offset 8 -> account_id: ${data.readBigUInt64LE(base5 + 8)}`);
  console.log(`  offset 16 -> capital lo: ${data.readBigUInt64LE(base5 + 16)}`);
  console.log(`  offset 24 -> capital hi: ${data.readBigUInt64LE(base5 + 24)}`);

  // Show what bytes 24-31 might represent
  console.log('\n=== Interpreting bytes 24-31 of account 5 ===');
  const bytes24 = data.subarray(base5 + 24, base5 + 32);
  console.log(`Raw hex: ${bytes24.toString('hex')}`);
  console.log(`As u64 LE: ${data.readBigUInt64LE(base5 + 24)}`);
  console.log(`As u32 LE (first 4 bytes): ${data.readUInt32LE(base5 + 24)}`);
}

main().catch(console.error);
