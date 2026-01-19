/**
 * Check oracle price and calculate expected unrealized PnL
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine, parseAccount, parseUsedIndices } from '../src/solana/slab.js';
import fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const conn = new Connection('https://api.devnet.solana.com');

async function main() {
  // Get oracle price
  const oracleData = await conn.getAccountInfo(ORACLE);
  if (!oracleData) throw new Error('Oracle not found');

  // Chainlink/Pyth price feed - try to parse
  console.log('Oracle data length:', oracleData.data.length);
  console.log('First 64 bytes (hex):', oracleData.data.slice(0, 64).toString('hex'));

  // Try different offsets for price
  for (const off of [8, 0, 16, 32]) {
    try {
      const price = oracleData.data.readBigInt64LE(off);
      console.log(`Price at offset ${off}:`, price.toString(), '=', Number(price) / 1e8, 'USD');
    } catch {}
  }

  // Get slab data
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  console.log('\n=== USER POSITIONS ===');
  const payer = new PublicKey(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')).slice(32, 64));

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc.positionSize !== 0n) {
      const matcher = acc.matcherProgram?.toBase58() || 'null';
      const isLP = matcher !== 'null' && matcher !== '11111111111111111111111111111111';
      const type = isLP ? 'LP' : 'USER';
      const entry = Number(acc.entryPrice || 0);
      const pos = Number(acc.positionSize);

      console.log(`\n${type} ${idx}:`);
      console.log('  Position:', pos / 1e9, 'B', pos > 0 ? '(LONG)' : '(SHORT)');
      console.log('  Entry price:', entry);
      console.log('  Stored PnL:', Number(acc.pnl) / 1e9, 'SOL');
      console.log('  Capital:', Number(acc.capital) / 1e9, 'SOL');

      // Calculate expected PnL for various current prices
      for (const current of [6900, 6950, 7000]) {
        const unrealizedPnL = pos * (current - entry) / 1e6;
        console.log(`  If price=${current}: expected PnL = ${(unrealizedPnL / 1e9).toFixed(6)} SOL`);
      }
    }
  }

  console.log('\n=== ENGINE STATE ===');
  console.log('Vault:', Number(engine.vault) / 1e9, 'SOL');
  console.log('Insurance:', Number(engine.insuranceFund.balance) / 1e9, 'SOL');
  console.log('Risk reduction:', engine.riskReductionOnly);
}

main().catch(console.error);
