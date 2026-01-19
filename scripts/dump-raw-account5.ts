/**
 * Dump raw bytes for account index 5
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

  // Account 5 base offset
  const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 5 * ACCOUNT_SIZE;
  console.log('Account 5 base offset:', base);
  console.log('\n=== First 80 bytes of Account 5 ===');

  // Dump bytes in 8-byte chunks
  for (let i = 0; i < 80; i += 8) {
    const val = data.readBigUInt64LE(base + i);
    console.log(`  offset ${i.toString().padStart(2)}: ${val.toString().padStart(22)} (0x${val.toString(16).padStart(16, '0')})`);
  }

  // Check what the actual account_id should be
  console.log('\n=== Expected field locations ===');
  console.log('account_id: offset 0 (u64)');
  console.log('capital:    offset 8-23 (U128)');
  console.log('kind:       offset 24 (u8)');
  console.log('pnl:        offset 32-47 (I128)');

  // Read specific fields
  console.log('\n=== Parsed values ===');
  const accountId = data.readBigUInt64LE(base + 0);
  const capitalLo = data.readBigUInt64LE(base + 8);
  const capitalHi = data.readBigUInt64LE(base + 16);
  const kind = data.readUInt8(base + 24);
  const pnlLo = data.readBigUInt64LE(base + 32);
  const pnlHi = data.readBigInt64LE(base + 40);

  console.log('accountId:', accountId.toString(), `(0x${accountId.toString(16)})`);
  console.log('capital:', ((capitalHi << 64n) | capitalLo).toString());
  console.log('kind:', kind);
  console.log('pnl (i128):', ((pnlHi << 64n) | pnlLo).toString());

  // Check position_size at offset 88
  const posLo = data.readBigUInt64LE(base + 88);
  const posHi = data.readBigInt64LE(base + 96);
  console.log('position_size:', ((posHi << 64n) | posLo).toString());

  // Entry price at offset 104
  const entryPrice = data.readBigUInt64LE(base + 104);
  console.log('entry_price:', entryPrice.toString());

  // Compare with index 0 account to see pattern
  console.log('\n=== Index 0 (should be empty/freelist) ===');
  const base0 = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 0 * ACCOUNT_SIZE;
  for (let i = 0; i < 48; i += 8) {
    const val = data.readBigUInt64LE(base0 + i);
    console.log(`  offset ${i.toString().padStart(2)}: ${val.toString().padStart(22)} (0x${val.toString(16).padStart(16, '0')})`);
  }
}

main().catch(console.error);
