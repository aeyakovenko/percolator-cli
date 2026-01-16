/**
 * Check engine state for crank timing
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine } from '../src/solana/slab.js';
import * as fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const slot = await connection.getSlot();
  console.log('Current slot:', slot);

  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);

  console.log('\nEngine state:');
  console.log('  last_crank_slot:', engine.lastCrankSlot);
  console.log('  last_sweep_start_slot:', engine.lastSweepStartSlot);
  console.log('  max_crank_staleness_slots:', engine.maxCrankStalenessSlots);
  console.log('  current_slot:', engine.currentSlot);
  console.log('  crank_step:', engine.crankStep);

  const slotDiff = slot - Number(engine.lastCrankSlot);
  const sweepSlotDiff = slot - Number(engine.lastSweepStartSlot);

  console.log('\nStaleness check:');
  console.log(`  Crank age (slots): ${slotDiff}`);
  console.log(`  Sweep age (slots): ${sweepSlotDiff}`);
  console.log(`  Max allowed: ${engine.maxCrankStalenessSlots}`);
  console.log(`  Crank fresh: ${slotDiff <= engine.maxCrankStalenessSlots}`);
  console.log(`  Sweep fresh: ${sweepSlotDiff <= engine.maxCrankStalenessSlots}`);
}

main().catch(console.error);
