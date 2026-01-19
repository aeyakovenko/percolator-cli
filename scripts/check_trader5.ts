/**
 * Check Trader 5's account state
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount, parseUsedIndices } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);

  // Get used indices
  const usedIndices = parseUsedIndices(data);
  console.log('Used indices:', usedIndices);

  // Parse all accounts and show their state
  console.log('\n=== All Accounts ===');
  for (const idx of usedIndices) {
    const acc = parseAccount(data, idx);
    const capital = Number(acc.capital) / 1e9;
    const pnl = acc.pnl;
    const posSize = acc.positionSize;
    const entryPrice = Number(acc.entryPrice);

    console.log(`\nIndex ${idx}:`);
    console.log(`  accountId: ${acc.accountId}`);
    console.log(`  capital: ${capital.toFixed(4)} SOL`);
    console.log(`  pnl (raw): ${pnl.toString()}`);
    console.log(`  position_size: ${posSize.toString()}`);
    console.log(`  entry_price: ${entryPrice}`);

    // Calculate equity
    const capitalVal = Number(acc.capital);
    const pnlVal = Number(pnl);
    const posSizeVal = Number(posSize);
    // Mark PnL = position_size * (oracle_price - entry_price)
    // Assume oracle price ~7000 for now
    const oraclePrice = 7000n;
    const markPnl = posSizeVal * (7000 - entryPrice);
    const equity = capitalVal + pnlVal + markPnl;
    const maintReq = Math.abs(posSizeVal) * 7000 * 500 / 10000;  // 5% maintenance margin

    console.log(`  mark_pnl (est): ${(markPnl / 1e9).toFixed(4)} SOL`);
    console.log(`  equity (est): ${(equity / 1e9).toFixed(4)} SOL`);
    console.log(`  maint_req (est): ${(maintReq / 1e9).toFixed(4)} SOL`);
    console.log(`  margin_ratio (est): ${equity > 0 ? ((equity / maintReq) * 100).toFixed(1) : 'N/A'}%`);
  }
}

main().catch(console.error);
