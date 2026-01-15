/**
 * Analyze LP total value (capital + PnL) to verify spread earnings
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine, AccountKind } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Initial deposits (from README)
const INITIAL_LP_CAPITAL = 10_000_000_000n; // 10 SOL
const INITIAL_TRADER_CAPITAL = 1_000_000_000n; // 1 SOL each

// Oracle price (inverted)
const rawOraclePrice = 138_000_000n; // $138/SOL
const oraclePrice = 1_000_000_000_000n / rawOraclePrice; // ~7246

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const indices = parseUsedIndices(data);
  const engine = parseEngine(data);

  console.log('=== Full Market Analysis ===\n');
  console.log(`Oracle Price (inverted): ${oraclePrice}`);
  console.log(`Insurance Fund Revenue: ${Number(engine.insuranceFund.feeRevenue) / 1e9} SOL`);
  console.log('');

  // Analyze ALL accounts
  let totalCapital = 0n;
  let totalUnrealizedPnl = 0n;
  const accounts: { idx: number; label: string; capital: bigint; unrealizedPnl: bigint; entryPrice: bigint; posSize: bigint }[] = [];

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    const label = acc.kind === AccountKind.LP ? 'LP' : `Trader ${idx}`;
    const posSize = acc.positionSize;
    const entryPrice = acc.entryPrice;

    // Calculate unrealized PnL
    const priceDiff = oraclePrice - entryPrice;
    const unrealizedPnlLamports = (posSize * priceDiff) / 1_000_000n;

    totalCapital += acc.capital;
    totalUnrealizedPnl += unrealizedPnlLamports;

    accounts.push({
      idx,
      label,
      capital: acc.capital,
      unrealizedPnl: unrealizedPnlLamports,
      entryPrice,
      posSize,
    });
  }

  // Print each account
  for (const a of accounts) {
    const posDir = a.posSize > 0n ? 'LONG' : a.posSize < 0n ? 'SHORT' : 'FLAT';
    console.log(`[${a.idx}] ${a.label}:`);
    console.log(`  Position: ${a.posSize.toString()} (${posDir}) @ ${a.entryPrice}`);
    console.log(`  Capital: ${Number(a.capital) / 1e9} SOL`);
    console.log(`  Unrealized PnL: ${Number(a.unrealizedPnl) / 1e9} SOL`);
    console.log(`  Total Value: ${Number(a.capital + a.unrealizedPnl) / 1e9} SOL`);
    console.log('');
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Total Capital: ${Number(totalCapital) / 1e9} SOL`);
  console.log(`Total Unrealized PnL: ${Number(totalUnrealizedPnl) / 1e9} SOL`);
  console.log(`Total Market Value: ${Number(totalCapital + totalUnrealizedPnl) / 1e9} SOL`);
  console.log('');

  // Expected vs Actual
  const expectedTotal = INITIAL_LP_CAPITAL + INITIAL_TRADER_CAPITAL * 5n; // LP + 5 traders
  console.log(`Expected Initial: ${Number(expectedTotal) / 1e9} SOL (LP: 10 + Traders: 5 * 1)`);
  console.log(`Actual Total Value: ${Number(totalCapital + totalUnrealizedPnl) / 1e9} SOL`);
  console.log(`Difference: ${Number(totalCapital + totalUnrealizedPnl - expectedTotal) / 1e9} SOL`);
  console.log(`Insurance Fees Collected: ${Number(engine.insuranceFund.feeRevenue) / 1e9} SOL`);
  console.log('');

  // LP specific analysis
  const lp = accounts.find(a => a.label === 'LP');
  if (lp) {
    console.log('=== LP ANALYSIS ===');
    const lpTotalValue = lp.capital + lp.unrealizedPnl;
    const lpChange = lpTotalValue - INITIAL_LP_CAPITAL;
    const lpChangeBps = Number(lpChange * 10000n / INITIAL_LP_CAPITAL);
    console.log(`LP Total Value: ${Number(lpTotalValue) / 1e9} SOL`);
    console.log(`LP Change from 10 SOL: ${Number(lpChange) / 1e9} SOL (${lpChangeBps} bps)`);
    console.log('');
    console.log('Breakdown:');
    console.log(`  Capital change: ${Number(lp.capital - INITIAL_LP_CAPITAL) / 1e9} SOL`);
    console.log(`  Unrealized PnL: ${Number(lp.unrealizedPnl) / 1e9} SOL`);
  }
}

main().catch(console.error);
