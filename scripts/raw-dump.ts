/**
 * Raw byte dump of account 5 data
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
  console.log('Slab data length:', data.length);

  // Account 5 base
  const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 5 * ACCOUNT_SIZE;
  console.log('Account 5 base offset:', base);

  console.log('\n=== First 120 bytes of Account 5 ===');
  console.log('Expected layout:');
  console.log('  0-7:   account_id (u64)');
  console.log('  8-23:  capital (U128)');
  console.log('  24-31: kind (u8 + 7 padding)');
  console.log('  32-47: pnl (I128)');
  console.log('  48-63: reserved_pnl (U128)');
  console.log('  64-71: warmup_started (u64)');
  console.log('  72-87: warmup_slope (U128)');
  console.log('  88-103: position_size (I128)');
  console.log('  104-111: entry_price (u64)');

  console.log('\nRaw bytes (hex):');
  for (let i = 0; i < 120; i += 16) {
    const hex = data.subarray(base + i, base + i + 16).toString('hex');
    const formatted = hex.match(/.{1,2}/g)?.join(' ') || '';
    console.log(`  ${i.toString().padStart(3)}: ${formatted}`);
  }

  console.log('\nInterpreting key fields:');

  // Read as u64/U128/I128
  const accountId = data.readBigUInt64LE(base + 0);
  console.log(`  account_id (0-7): ${accountId}`);

  const capitalLo = data.readBigUInt64LE(base + 8);
  const capitalHi = data.readBigUInt64LE(base + 16);
  console.log(`  capital lo (8-15): ${capitalLo}`);
  console.log(`  capital hi (16-23): ${capitalHi}`);
  console.log(`  capital combined: ${(capitalHi << 64n) | capitalLo}`);

  const kind = data.readUInt8(base + 24);
  console.log(`  kind (24): ${kind} (${kind === 0 ? 'User' : kind === 1 ? 'LP' : 'Unknown'})`);

  const pnlLo = data.readBigUInt64LE(base + 32);
  const pnlHi = data.readBigUInt64LE(base + 40);
  console.log(`  pnl lo (32-39): ${pnlLo}`);
  console.log(`  pnl hi (40-47): ${pnlHi}`);

  const posLo = data.readBigUInt64LE(base + 88);
  const posHi = data.readBigUInt64LE(base + 96);
  console.log(`  position lo (88-95): ${posLo}`);
  console.log(`  position hi (96-103): ${posHi}`);

  const entryPrice = data.readBigUInt64LE(base + 104);
  console.log(`  entry_price (104-111): ${entryPrice}`);
}

main().catch(console.error);
