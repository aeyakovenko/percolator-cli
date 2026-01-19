/**
 * Check if accounts are at offset 95248 instead of 95256
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const ENGINE_OFF = 328;
const CLI_ACCOUNTS_OFF = 95256;  // What CLI uses
const RUST_ACCOUNTS_OFF = 95248; // What Rust code produces
const ACCOUNT_SIZE = 248;

async function main() {
  const data = await fetchSlab(connection, SLAB);

  console.log('=== Comparing account 5 at different offsets ===\n');

  // CLI offset
  const cliBase = ENGINE_OFF + CLI_ACCOUNTS_OFF + 5 * ACCOUNT_SIZE;
  console.log('CLI base offset:', cliBase);

  // Rust offset
  const rustBase = ENGINE_OFF + RUST_ACCOUNTS_OFF + 5 * ACCOUNT_SIZE;
  console.log('Rust base offset:', rustBase);
  console.log('Difference:', cliBase - rustBase, 'bytes\n');

  // Read from CLI offset (what CLI sees)
  console.log('=== At CLI offset (95256) ===');
  const cliAccountId = data.readBigUInt64LE(cliBase + 0);
  const cliCapitalLo = data.readBigUInt64LE(cliBase + 8);
  const cliKind = data.readUInt8(cliBase + 24);
  console.log('accountId:', cliAccountId.toString());
  console.log('capital (lo):', cliCapitalLo.toString());
  console.log('kind:', cliKind);

  // Read from Rust offset (what the program actually stores)
  console.log('\n=== At Rust offset (95248) ===');
  const rustAccountId = data.readBigUInt64LE(rustBase + 0);
  const rustCapitalLo = data.readBigUInt64LE(rustBase + 8);
  const rustKind = data.readUInt8(rustBase + 24);
  console.log('accountId:', rustAccountId.toString());
  console.log('capital (lo):', rustCapitalLo.toString());
  console.log('kind:', rustKind);

  // Also check account 1 (should have accountId=10)
  console.log('\n=== Account 1 at Rust offset ===');
  const acc1Base = ENGINE_OFF + RUST_ACCOUNTS_OFF + 1 * ACCOUNT_SIZE;
  const acc1Id = data.readBigUInt64LE(acc1Base + 0);
  const acc1CapLo = data.readBigUInt64LE(acc1Base + 8);
  const acc1Kind = data.readUInt8(acc1Base + 24);
  const acc1PnlLo = data.readBigUInt64LE(acc1Base + 32);
  const acc1PnlHi = data.readBigInt64LE(acc1Base + 40);
  console.log('accountId:', acc1Id.toString());
  console.log('capital (lo):', acc1CapLo.toString());
  console.log('kind:', acc1Kind);
  console.log('pnl (i128):', ((acc1PnlHi << 64n) | acc1PnlLo).toString());

  // Check what's at the 8-byte gap
  console.log('\n=== Data in the 8-byte gap (95248-95256) ===');
  const gapStart = ENGINE_OFF + RUST_ACCOUNTS_OFF;
  console.log('Offset', gapStart - 8, 'to', gapStart);
  for (let i = -8; i < 8; i += 1) {
    const byte = data.readUInt8(gapStart + i);
    process.stdout.write(`${byte.toString(16).padStart(2, '0')} `);
    if (i === -1) process.stdout.write('| ');
  }
  console.log();
}

main().catch(console.error);
