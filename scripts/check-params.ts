import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseParams } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const params = parseParams(data);
  console.log('Liquidation Parameters:');
  console.log('  Fee (bps):', params.liquidationFeeBps.toString());
  console.log('  Fee Cap:', params.liquidationFeeCap.toString());
  console.log('  Buffer (bps):', params.liquidationBufferBps.toString());
  console.log('  Min Liquidation Abs:', params.minLiquidationAbs.toString());
  console.log('');
  console.log('Other Params:');
  console.log('  Maintenance Margin (bps):', params.maintenanceMarginBps.toString());
  console.log('  Initial Margin (bps):', params.initialMarginBps.toString());
}
main();
