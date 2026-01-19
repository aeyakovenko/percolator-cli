/**
 * Deep investigation of slab layout
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const ENGINE_OFF = 328;

// Search for account 5's known values to find actual offset
// We know: position_size ≈ 650e9 = 0x975704e400 (bytes: 00 e4 04 57 97 00 00 00 ...)
// We know: entry_price = 7029 = 0x1b75 (bytes: 75 1b 00 00 00 00 00 00)

async function main() {
  const data = await fetchSlab(connection, SLAB);
  console.log('Slab length:', data.length);

  // Search for entry_price pattern: 75 1b 00 00 00 00 00 00
  console.log('\n=== Searching for entry_price = 7029 (0x1b75) ===');
  const entryPriceBytes = Buffer.from([0x75, 0x1b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

  for (let i = 90000; i < data.length - 8; i++) {
    if (data.compare(entryPriceBytes, 0, 8, i, i + 8) === 0) {
      console.log(`Found entry_price at offset ${i} (relative to engine: ${i - ENGINE_OFF})`);

      // If entry_price is at offset 96 in Account, then account base is i - 96
      const accountBase = i - 96;
      console.log(`  If entry_price is at +96, account base would be ${accountBase}`);
      console.log(`  Account base relative to engine: ${accountBase - ENGINE_OFF}`);

      // Check surrounding bytes
      console.log(`  Bytes at base-16 to base+120:`);
      for (let j = -16; j < 120; j += 16) {
        const start = accountBase + j;
        const hex = data.subarray(start, start + 16).toString('hex');
        const formatted = hex.match(/.{1,2}/g)?.join(' ') || '';
        console.log(`    ${j.toString().padStart(4)}: ${formatted}`);
      }

      // Try to interpret as Account
      console.log(`\n  Interpreting as Account from base ${accountBase}:`);
      const accountId = data.readBigUInt64LE(accountBase);
      const capitalLo = data.readBigUInt64LE(accountBase + 8);
      const capitalHi = data.readBigUInt64LE(accountBase + 16);
      const capital = (capitalHi << 64n) | capitalLo;
      const kind = data.readUInt8(accountBase + 24);
      const positionLo = data.readBigUInt64LE(accountBase + 80);
      const positionHi = data.readBigUInt64LE(accountBase + 88);
      const entryPrice = data.readBigUInt64LE(accountBase + 96);

      console.log(`    account_id: ${accountId}`);
      console.log(`    capital: ${capital} (${(Number(capital) / 1e9).toFixed(4)} SOL)`);
      console.log(`    kind: ${kind}`);
      console.log(`    position_size: ${(positionHi << 64n) | positionLo}`);
      console.log(`    entry_price: ${entryPrice}`);
    }
  }

  // Also search for position_size pattern
  console.log('\n=== Searching for position_size ≈ 650e9 ===');
  // 650000000000 = 0x975704e400
  // In little-endian: 00 e4 04 57 97 00 00 00 00 00 00 00 00 00 00 00
  const posBytes = Buffer.from([0x00, 0xe4, 0x04, 0x57, 0x97, 0x00, 0x00, 0x00]);

  for (let i = 90000; i < data.length - 8; i++) {
    if (data.compare(posBytes, 0, 8, i, i + 8) === 0) {
      console.log(`Found position_size at offset ${i} (relative to engine: ${i - ENGINE_OFF})`);
    }
  }

  // Dump engine header area
  console.log('\n=== Engine header (first 256 bytes) ===');
  for (let i = 0; i < 256; i += 16) {
    const hex = data.subarray(ENGINE_OFF + i, ENGINE_OFF + i + 16).toString('hex');
    const formatted = hex.match(/.{1,2}/g)?.join(' ') || '';
    console.log(`  ${i.toString().padStart(3)}: ${formatted}`);
  }
}

main().catch(console.error);
