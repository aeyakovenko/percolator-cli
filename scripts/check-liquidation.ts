/**
 * Check liquidation risk for all accounts
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount, parseParams, parseUsedIndices, AccountKind } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const params = parseParams(data);
  const indices = parseUsedIndices(data);

  // Oracle price ~$138
  const price = 138_000_000n; // e6

  console.log('=== Risk Parameters ===');
  console.log('Maintenance Margin:', params.maintenanceMarginBps.toString(), 'bps');
  console.log('Initial Margin:', params.initialMarginBps.toString(), 'bps');
  console.log('');

  console.log('=== Liquidation Analysis ===');
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const label = acc.kind === AccountKind.LP ? 'LP' : `Trader ${idx}`;

    const posAbs = acc.positionSize < 0n ? -acc.positionSize : acc.positionSize;
    const notional = posAbs * price / 1_000_000n;  // in lamports
    const maintenanceReq = notional * params.maintenanceMarginBps / 10_000n;

    // Effective capital = capital + pnl (pnl can be negative)
    let pnl = acc.pnl;
    // Handle unsigned overflow display (negative i128 read as large positive)
    if (pnl > 9_000_000_000_000_000_000n) {
      pnl = pnl - 18446744073709551616n; // Convert from u64 overflow to signed
    }
    const effectiveCapital = acc.capital + pnl;

    const marginRatio = notional > 0n ? (effectiveCapital * 10000n / notional) : 99999n;
    const buffer = effectiveCapital - maintenanceReq;

    const status = buffer < 0n ? '🔴 LIQUIDATABLE' :
                   marginRatio < params.maintenanceMarginBps * 2n ? '🟡 AT RISK' : '🟢 SAFE';

    console.log(`[${idx}] ${label}: ${status}`);
    console.log(`    Position: ${acc.positionSize} (${acc.positionSize > 0n ? 'LONG' : acc.positionSize < 0n ? 'SHORT' : 'FLAT'})`);
    console.log(`    Capital: ${Number(acc.capital) / 1e9} SOL`);
    console.log(`    PnL: ${Number(pnl) / 1e9} SOL`);
    console.log(`    Effective Capital: ${Number(effectiveCapital) / 1e9} SOL`);
    console.log(`    Notional: ${Number(notional) / 1e9} SOL`);
    console.log(`    Maintenance Req: ${Number(maintenanceReq) / 1e9} SOL`);
    console.log(`    Buffer: ${Number(buffer) / 1e9} SOL`);
    console.log(`    Margin Ratio: ${Number(marginRatio) / 100}%`);
    console.log('');
  }
}

main().catch(console.error);
