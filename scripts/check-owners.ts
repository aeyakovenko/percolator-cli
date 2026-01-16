/**
 * Check account owners in the new slab
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount, parseUsedIndices } from '../src/solana/slab.js';
import * as fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const usedIndices = parseUsedIndices(data);

  console.log('Used indices:', usedIndices);

  for (const idx of usedIndices) {
    const account = parseAccount(data, idx);
    console.log(`\nAccount ${idx}:`);
    console.log(`  Account ID: ${account.accountId}`);
    console.log(`  Kind: ${account.kind === 1 ? 'LP' : 'User'}`);
    console.log(`  Owner: ${account.owner.toBase58()}`);
    console.log(`  Capital: ${Number(account.capital) / 1e9} SOL`);
    console.log(`  Position: ${Number(account.positionSize) / 1e9} units`);
    console.log(`  Matcher Program: ${account.matcherProgram?.toBase58() || 'N/A'}`);
    console.log(`  Matcher Context: ${account.matcherContext?.toBase58() || 'N/A'}`);
  }

  // Print admin for comparison
  console.log(`\nAdmin from market info: ${marketInfo.admin}`);
}

main().catch(console.error);
