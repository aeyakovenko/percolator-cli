import "dotenv/config";
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { fetchSlab, parseUsedIndices, parseAccount, AccountKind } from '../src/solana/slab.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const ADMIN = new PublicKey(marketInfo.admin);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

async function main() {
  const slabData = await fetchSlab(conn, SLAB);
  const usedIndices = parseUsedIndices(slabData);

  console.log('LP Accounts (owner = our admin can close):');
  console.log('Admin:', ADMIN.toBase58());
  console.log('='.repeat(80));

  for (const idx of usedIndices) {
    const account = parseAccount(slabData, idx);
    // Check if LP
    const isLp = account.matcherProgram && !account.matcherProgram.equals(PublicKey.default);
    if (isLp) {
      const weOwn = account.owner.equals(ADMIN);
      const canClose = account.positionSize === 0n && weOwn;
      console.log(`LP ${idx}:`);
      console.log(`  Owner: ${account.owner.toBase58()}`);
      console.log(`  We own: ${weOwn}`);
      console.log(`  Capital: ${Number(account.capital) / 1e9} SOL`);
      console.log(`  Position: ${account.positionSize}`);
      console.log(`  Can close: ${canClose}`);
      console.log('');
    }
  }
}

main().catch(console.error);
