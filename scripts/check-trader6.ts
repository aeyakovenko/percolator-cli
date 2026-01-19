import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';
import * as fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const trader6 = parseAccount(data, 6);
  
  if (!trader6) {
    console.log('Trader 6 account not found (may have been closed)');
    return;
  }
  
  console.log('=== TRADER 6 STATE ===');
  console.log('Capital:', Number(trader6.capital) / 1e9, 'SOL');
  console.log('Position:', trader6.positionSize.toString());
  console.log('PnL:', Number(trader6.pnl) / 1e9, 'SOL');
  console.log('Last Fee Slot:', trader6.lastFeeSlot?.toString() || 'N/A');
  console.log('Fee Credits:', Number(trader6.feeCredits) / 1e9);
}
main().catch(console.error);
