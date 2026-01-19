/**
 * Verify what data is at specific absolute offsets
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);

  // According to CLI:
  // Account 1 is at ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 1 * ACCOUNT_SIZE
  // = 328 + 95256 + 248 = 95832
  const cliAccount1Base = 328 + 95256 + 1 * 248;
  console.log('CLI Account 1 absolute offset:', cliAccount1Base);

  // According to Rust (no padding):
  // Account 1 is at ENGINE_OFF + 95248 + 1 * ACCOUNT_SIZE
  // = 328 + 95248 + 248 = 95824
  const rustAccount1Base = 328 + 95248 + 1 * 248;
  console.log('Rust Account 1 absolute offset:', rustAccount1Base);

  console.log('\n=== Reading u64 at various absolute offsets around account 1 ===');
  for (let offset = 95820; offset <= 95860; offset += 4) {
    const val = data.readBigUInt64LE(offset);
    const valHex = val.toString(16).padStart(16, '0');
    let note = '';
    if (offset === rustAccount1Base) note = ' <-- Rust base';
    if (offset === cliAccount1Base) note = ' <-- CLI base';
    if (val === 10n) note += ' [value=10, likely accountId]';
    if (val > 0n && val < 1000000000000n) note += ' [could be capital/position]';
    console.log(`offset ${offset}: 0x${valHex} = ${val.toString().padStart(22)}${note}`);
  }

  // Let's also check if "10" appears anywhere
  console.log('\n=== Searching for value 10 (accountId) in account area ===');
  const searchStart = 328 + 95200; // A bit before expected account area
  const searchEnd = 328 + 95300;
  for (let offset = searchStart; offset < searchEnd; offset += 8) {
    const val = data.readBigUInt64LE(offset);
    if (val === 10n) {
      console.log(`Found 10 at absolute offset ${offset} (engine-relative: ${offset - 328})`);
    }
  }
}

main().catch(console.error);
