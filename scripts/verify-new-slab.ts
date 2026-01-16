/**
 * Verify new slab has correct struct layout
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseAccount } from '../src/solana/slab.js';

const SLAB = new PublicKey('GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  console.log('Slab length:', data.length);

  const header = parseHeader(data);
  console.log('\n=== Header ===');
  console.log('Version:', header.version);
  console.log('Admin:', header.admin.toBase58());

  const config = parseConfig(data);
  console.log('\n=== Config ===');
  console.log('Inverted:', config.invert === 1 ? 'Yes' : 'No');

  const engine = parseEngine(data);
  console.log('\n=== Engine ===');
  console.log('Insurance fund:', Number(engine.insuranceFund.balance) / 1e9, 'SOL');
  console.log('Risk reduction:', engine.riskReductionOnly);

  // Check LP account (index 0)
  console.log('\n=== LP Account (index 0) ===');
  const lpAccount = parseAccount(data, 0);
  console.log('Account ID:', lpAccount.accountId);
  console.log('Capital:', Number(lpAccount.capital) / 1e9, 'SOL');
  console.log('Kind:', lpAccount.kind === 1 ? 'LP' : 'User');
  console.log('PnL:', Number(lpAccount.pnl) / 1e9, 'SOL');
  console.log('Position size:', Number(lpAccount.positionSize) / 1e9, 'units');
  console.log('Entry price:', Number(lpAccount.entryPrice));

  // Verify struct layout by reading raw bytes
  console.log('\n=== Verifying struct layout ===');
  const ENGINE_OFF = 328;
  const ENGINE_ACCOUNTS_OFF = 95256;
  const ACCOUNT_SIZE = 248;
  const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + 0 * ACCOUNT_SIZE;

  console.log('LP account base offset:', base);
  console.log('Raw first 112 bytes:');
  for (let i = 0; i < 112; i += 16) {
    const hex = data.subarray(base + i, base + i + 16).toString('hex');
    const formatted = hex.match(/.{1,2}/g)?.join(' ') || '';
    console.log(`  ${i.toString().padStart(3)}: ${formatted}`);
  }

  // Verify individual field offsets
  console.log('\nField values at expected offsets:');
  console.log(`  account_id (0): ${data.readBigUInt64LE(base + 0)}`);
  console.log(`  capital lo (8): ${data.readBigUInt64LE(base + 8)}`);
  console.log(`  capital hi (16): ${data.readBigUInt64LE(base + 16)}`);
  console.log(`  kind (24): ${data[base + 24]}`);
  console.log(`  pnl lo (32): ${data.readBigUInt64LE(base + 32)}`);
  console.log(`  position_size lo (80): ${data.readBigUInt64LE(base + 80)}`);
  console.log(`  entry_price (96): ${data.readBigUInt64LE(base + 96)}`);
}

main().catch(console.error);
