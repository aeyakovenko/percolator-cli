/**
 * Print RiskParams for a slab.
 *
 * Usage:
 *   npx tsx scripts/check-params.ts [--slab <pubkey>] [--url <rpc>]
 *
 * If --slab is omitted, falls back to devnet-market.json in cwd.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseParams, parseConfig } from '../src/solana/slab.js';
import * as fs from 'fs';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const argSlab = getArg('slab');
const argUrl = getArg('url');

let SLAB: PublicKey;
if (argSlab) {
  SLAB = new PublicKey(argSlab);
} else {
  const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
  SLAB = new PublicKey(marketInfo.slab);
}
const RPC_URL = argUrl ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const params = parseParams(data);
  const config = parseConfig(data);

  console.log('Slab:', SLAB.toBase58());
  console.log('RPC: ', RPC_URL);
  console.log('');
  console.log('Liquidation Parameters:');
  console.log('  Fee (bps):          ', params.liquidationFeeBps.toString());
  console.log('  Fee Cap:            ', params.liquidationFeeCap.toString());
  console.log('  Min Liquidation Abs:', params.minLiquidationAbs.toString());
  console.log('');
  console.log('Margin Parameters:');
  console.log('  Maintenance Margin (bps):', params.maintenanceMarginBps.toString());
  console.log('  Initial Margin (bps):    ', params.initialMarginBps.toString());
  console.log('  Trading Fee (bps):       ', params.tradingFeeBps.toString());
  console.log('');
  console.log('Fee Parameters (from MarketConfig):');
  console.log('  Maintenance Fee/slot:', config.maintenanceFeePerSlot.toString());
  console.log('  New Account Fee:     ', config.newAccountFee.toString());
  console.log('');
  console.log('Funding Parameters:');
  console.log('  funding_k_bps:       ', config.fundingKBps.toString());
  console.log('  Horizon Slots:       ', config.fundingHorizonSlots.toString());
  console.log('  Max Premium (bps):   ', config.fundingMaxPremiumBps.toString());
  console.log('  maxAbsFundingE9/slot:', params.maxAbsFundingE9PerSlot.toString());
  console.log('');
  console.log('Resolve Parameters:');
  console.log('  permResolveStaleSlots:', config.permissionlessResolveStaleSlots.toString());
  console.log('  forceCloseDelaySlots: ', config.forceCloseDelaySlots.toString());
  console.log('');
  console.log('Accounts:');
  console.log('  maxAccounts:             ', params.maxAccounts.toString());
  console.log('  maxActivePositionsPerSide:', params.maxActivePositionsPerSide.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
