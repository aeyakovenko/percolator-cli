/**
 * Debug script to examine Trader 1's pnl field
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Account layout constants from slab.ts
const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;
const ACCT_PNL_OFF = 32;

async function main() {
  const data = await fetchSlab(connection, SLAB);

  // Parse account 1 (Trader 1)
  const trader1 = parseAccount(data, 1);
  console.log('=== Trader 1 Account ===');
  console.log('accountId:', trader1.accountId.toString());
  console.log('capital:', trader1.capital.toString(), `(${Number(trader1.capital) / 1e9} SOL)`);
  console.log('pnl (bigint):', trader1.pnl.toString());
  console.log('pnl (hex):', trader1.pnl.toString(16));
  console.log('pnl (as SOL):', Number(trader1.pnl) / 1e9);

  // Check against 2^64
  const twoTo64 = 2n ** 64n;
  console.log('\n=== Comparison ===');
  console.log('2^64 =', twoTo64.toString());
  console.log('pnl - 2^64 =', (trader1.pnl - twoTo64).toString());
  console.log('Is pnl negative i128?', trader1.pnl >= 2n ** 127n ? 'Yes (if interpreting upper bit as sign)' : 'No');

  // Read raw bytes at pnl offset
  const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 1 * ACCOUNT_SIZE;
  const pnlOffset = base + ACCT_PNL_OFF;
  console.log('\n=== Raw Bytes at PNL offset', pnlOffset, '===');
  const pnlBytes = data.subarray(pnlOffset, pnlOffset + 16);
  console.log('Hex:', pnlBytes.toString('hex'));

  // Parse manually
  const lo = data.readBigUInt64LE(pnlOffset);
  const hi = data.readBigInt64LE(pnlOffset + 8);
  const hiUnsigned = data.readBigUInt64LE(pnlOffset + 8);
  console.log('Low 64 bits (unsigned):', lo.toString(), `(0x${lo.toString(16)})`);
  console.log('High 64 bits (signed):', hi.toString(), `(0x${hi.toString(16)})`);
  console.log('High 64 bits (unsigned):', hiUnsigned.toString(), `(0x${hiUnsigned.toString(16)})`);

  // Reconstruct as signed i128
  const asSignedI128 = (hi << 64n) | lo;
  console.log('\nReconstructed as i128:', asSignedI128.toString());

  // Check if this is a small negative number being misread
  if (hiUnsigned === 0xFFFFFFFFFFFFFFFFn) {
    // All 1s in high bits = negative number
    const negValue = asSignedI128;
    console.log('This appears to be a negative i128 value:', negValue.toString());
  }

  // Also check surrounding bytes for context
  console.log('\n=== Surrounding Context ===');
  console.log('Account base offset:', base);
  console.log('PNL at offset:', ACCT_PNL_OFF, '(absolute:', pnlOffset, ')');

  // Show bytes around the pnl field
  console.log('\nBytes 24-48 (around pnl):');
  for (let i = 24; i < 48; i += 8) {
    const val = data.readBigUInt64LE(base + i);
    console.log(`  offset ${i}: ${val.toString()} (0x${val.toString(16).padStart(16, '0')})`);
  }

  // Check the kind byte
  const kindByte = data.readUInt8(base + 24);
  console.log('\nKind byte at offset 24:', kindByte);
}

main().catch(console.error);
