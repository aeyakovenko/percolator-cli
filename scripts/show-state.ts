import { Connection, PublicKey } from '@solana/web3.js';
import { parseUsedIndices, parseAccount, parseEngine } from '../src/solana/slab.js';

const conn = new Connection('https://api.devnet.solana.com');
const SLAB = new PublicKey('CWaDTsGp6ArBBnMmbFkZ7BU1SzDdbMSzCRPRRvnHVRwm');

async function main() {
  const info = await conn.getAccountInfo(SLAB);
  if (!info) throw new Error('Slab not found');

  const usedIndices = parseUsedIndices(info.data);
  const engine = parseEngine(info.data);

  console.log('=== Wrapped SOL Market State ===');
  console.log('Slab:', SLAB.toBase58());
  console.log('Insurance Fund:', (Number(engine.insuranceFund.balance) / 1e9).toFixed(4), 'SOL');
  console.log('Used indices:', usedIndices);
  console.log('');

  for (const idx of usedIndices) {
    try {
      const account = parseAccount(info.data, idx);
      if (account) {
        const kind = account.kind === 1 ? 'LP' : 'User';
        console.log(`Account ${idx} (${kind}):`);
        console.log('  Owner:', account.owner.toBase58().slice(0, 20) + '...');
        console.log('  Position:', account.positionSize?.toString() ?? 'N/A');
        console.log('  Capital:', account.capital ? (Number(account.capital) / 1e9).toFixed(6) + ' SOL' : 'N/A');
      }
    } catch (e: any) {
      console.log(`Account ${idx}: Error parsing - ${e.message}`);
    }
  }
}
main().catch(console.error);
