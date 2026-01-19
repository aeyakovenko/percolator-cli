/**
 * Check if traders are getting expected PnL profits
 */
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine } from '../src/solana/slab.js';
import fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const LP_IDX = marketInfo.lp.index;
const conn = new Connection('https://api.devnet.solana.com');
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  console.log('=== TRADER CAPITAL & PNL STATUS ===\n');

  let totalUserCapital = 0n;
  const users: { idx: number; capital: bigint; pnl: bigint; position: bigint }[] = [];

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || 'null';
    const isLP = matcher !== 'null' && matcher !== '11111111111111111111111111111111';

    if (!isLP && acc.owner.equals(payer.publicKey)) {
      console.log(`User ${idx}:`);
      console.log(`  Capital: ${(Number(acc.capital)/1e9).toFixed(4)} SOL`);
      console.log(`  Position: ${acc.positionSize.toString()}`);
      console.log(`  Stored PnL: ${(Number(acc.pnl)/1e9).toFixed(6)} SOL`);
      console.log(`  Entry price: ${acc.entryPrice?.toString() || 'N/A'}`);
      totalUserCapital += acc.capital;
      users.push({ idx, capital: acc.capital, pnl: acc.pnl, position: acc.positionSize });
    }
  }

  const lpAcc = parseAccount(data, LP_IDX);
  console.log(`\nLP ${LP_IDX}:`);
  console.log(`  Capital: ${(Number(lpAcc.capital)/1e9).toFixed(4)} SOL`);
  console.log(`  Position: ${lpAcc.positionSize.toString()}`);
  console.log(`  Stored PnL: ${(Number(lpAcc.pnl)/1e9).toFixed(6)} SOL`);
  console.log(`  Entry price: ${lpAcc.entryPrice?.toString() || 'N/A'}`);

  console.log('\n=== ANALYSIS ===');
  console.log(`Total user capital: ${(Number(totalUserCapital)/1e9).toFixed(4)} SOL`);
  console.log(`LP capital: ${(Number(lpAcc.capital)/1e9).toFixed(4)} SOL`);
  console.log(`LP accumulated PnL: ${(Number(lpAcc.pnl)/1e9).toFixed(4)} SOL`);
  console.log(`Vault: ${(Number(engine.vault)/1e9).toFixed(4)} SOL`);
  console.log(`Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);

  // The key question: where did LP's 9+ SOL PnL come from?
  // It came from: 1) bid-ask spread on user trades, 2) user losses
  console.log('\n=== PNL FLOW ANALYSIS ===');
  console.log('LP has accumulated PnL of', (Number(lpAcc.pnl)/1e9).toFixed(4), 'SOL');
  console.log('This profit came from:');
  console.log('  1. Bid-ask spread on every trade (LONGs enter higher, SHORTs enter lower)');
  console.log('  2. Net user losses from price movement');
  console.log('');
  console.log('Users pay:');
  console.log('  - Trading fees (10 BPS) → goes to insurance fund');
  console.log('  - Spread to LP → goes to LP PnL');
  console.log('  - Realized losses from price movement → goes to LP if LP took other side');
}

main().catch(console.error);
