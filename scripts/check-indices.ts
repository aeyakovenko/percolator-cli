import "dotenv/config";
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { fetchSlab, parseUsedIndices } from '../src/solana/slab.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

async function main() {
  const slabData = await fetchSlab(conn, SLAB);
  const usedIndices = parseUsedIndices(slabData);
  console.log('Used indices:', usedIndices.join(', '));
  console.log('Max:', Math.max(...usedIndices));

  // Find first free index
  for (let i = 0; i < 50; i++) {
    if (!usedIndices.includes(i)) {
      console.log('First free index:', i);
      break;
    }
  }
}
main();
