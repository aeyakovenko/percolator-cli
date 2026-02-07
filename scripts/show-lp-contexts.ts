import "dotenv/config";
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { fetchSlab, parseUsedIndices, parseAccount, AccountKind } from '../src/solana/slab.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

async function main() {
  const slabData = await fetchSlab(conn, SLAB);
  const usedIndices = parseUsedIndices(slabData);

  console.log('LP Matcher Contexts:');
  console.log('='.repeat(80));

  for (const idx of usedIndices) {
    const account = parseAccount(slabData, idx);
    // Check if LP
    const isLp = account.matcherProgram && !account.matcherProgram.equals(PublicKey.default);
    if (isLp) {
      console.log(`LP ${idx}:`);
      console.log(`  Matcher Program: ${account.matcherProgram.toBase58()}`);
      console.log(`  Matcher Context: ${account.matcherContext.toBase58()}`);
      console.log(`  Capital: ${Number(account.capital) / 1e9} SOL`);
      console.log(`  Position: ${account.positionSize}`);
      console.log('');
    }
  }
}

main().catch(console.error);
