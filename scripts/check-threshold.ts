import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine, parseParams, parseConfig } from '../src/solana/slab.js';
import * as fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const config = parseConfig(data);

  console.log('=== RISK THRESHOLD STATUS ===');
  console.log('Insurance Balance:', Number(engine.insuranceFund.balance) / 1e9, 'SOL');
  console.log('Risk Threshold (engine):', Number(engine.riskReductionThreshold || 0) / 1e9, 'SOL');
  console.log('Risk Threshold (params):', Number(params.riskReductionThreshold) / 1e9, 'SOL');
  const gateActive = Number(engine.insuranceFund.balance) <= Number(params.riskReductionThreshold);
  console.log('Risk Reduction Gate:', gateActive ? 'ACTIVE' : 'inactive');
  console.log('Risk Reduction Mode:', engine.riskReductionOnly);
  console.log('Total OI:', Number(engine.totalOpenInterest) / 1e9, 'B');
  console.log('Liquidations:', engine.lifetimeLiquidations.toString());

  console.log('\n=== CONFIG (threshold params) ===');
  console.log('  threshFloor:', config.threshFloor?.toString());
  console.log('  threshRiskBps:', config.threshRiskBps?.toString());
  console.log('  threshMin:', config.threshMin?.toString());
  console.log('  threshMax:', config.threshMax?.toString());
  console.log('  threshStepBps:', config.threshStepBps?.toString());
  console.log('  threshAlphaBps:', config.threshAlphaBps?.toString());

  const surplus = Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold);
  console.log('\nSurplus:', surplus / 1e9, 'SOL');
}
main().catch(console.error);
