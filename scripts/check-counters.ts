/**
 * Check risk engine counters
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine } from '../src/solana/slab.js';

const SLAB = new PublicKey('8CUcauuMqAiB2xnT5c8VNM4zDHfbsedz6eLTAhHjACTe');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);

  console.log('=== Risk Engine State ===\n');

  console.log('Vault:', Number(engine.vault) / 1e9, 'SOL');
  console.log('Insurance Fund:', Number(engine.insuranceFund.balance) / 1e9, 'SOL');
  console.log('  Fee Revenue:', Number(engine.insuranceFund.feeRevenue) / 1e9, 'SOL');
  console.log('');

  console.log('Loss Accum:', engine.lossAccum.toString());
  console.log('Risk Reduction Only:', engine.riskReductionOnly);
  console.log('Risk Reduction Withdrawn:', engine.riskReductionModeWithdrawn.toString());
  console.log('');

  console.log('Warmup:');
  console.log('  Paused:', engine.warmupPaused);
  console.log('  Pause Slot:', engine.warmupPauseSlot.toString());
  console.log('  Warmed Pos Total:', engine.warmedPosTotal.toString());
  console.log('  Warmed Neg Total:', engine.warmedNegTotal.toString());
  console.log('  Insurance Reserved:', engine.warmupInsuranceReserved.toString());
  console.log('');

  console.log('Crank:');
  console.log('  Current Slot:', engine.currentSlot.toString());
  console.log('  Last Crank Slot:', engine.lastCrankSlot.toString());
  console.log('  Last Funding Slot:', engine.lastFundingSlot.toString());
  console.log('  Max Staleness:', engine.maxCrankStalenessSlots.toString(), 'slots');
  console.log('');

  console.log('Open Interest:', Number(engine.totalOpenInterest) / 1e9, '(units/1e9)');
  console.log('Funding Index:', engine.fundingIndexQpbE6.toString());
  console.log('');

  console.log('Accounts:');
  console.log('  Used:', engine.numUsedAccounts);
  console.log('  Next ID:', engine.nextAccountId.toString());
}

main().catch(console.error);
