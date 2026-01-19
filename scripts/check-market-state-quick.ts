import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from '../src/solana/slab.js';
import fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const SLAB = new PublicKey(marketInfo.slab);

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  console.log('=== Market State ===');
  console.log('Insurance:', (Number(engine.insuranceFund.balance) / 1e9).toFixed(6), 'SOL');
  console.log('Lifetime liquidations:', engine.lifetimeLiquidations.toString());
  console.log('\nAccounts:');

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      console.log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize} pnl=${(Number(acc.realizedPnl) / 1e9).toFixed(6)}`);
    }
  }
}

main().catch(console.error);
