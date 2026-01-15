/**
 * Find user account index by owner pubkey
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount, parseUsedIndices } from '../src/solana/slab.js';

const SLAB = new PublicKey(process.argv[2] || 'Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const OWNER = process.argv[3] ? new PublicKey(process.argv[3]) : null;
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  if (!process.argv[3]) {
    console.log('Usage: npx tsx scripts/find-user.ts <slab_pubkey> <owner_pubkey>');
    console.log('\nListing all accounts on slab...\n');
  }

  const data = await fetchSlab(connection, SLAB);
  const indices = parseUsedIndices(data);

  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Accounts found: ${indices.length}\n`);

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    const isMatch = OWNER && acc.owner.equals(OWNER);
    const marker = isMatch ? ' <-- YOUR ACCOUNT' : '';

    console.log(`[${idx}] Owner: ${acc.owner.toBase58()}${marker}`);
    console.log(`     Position: ${acc.positionSize}, Capital: ${Number(acc.capital) / 1e9} SOL`);

    if (isMatch) {
      console.log(`\n✓ Your user index is: ${idx}`);
    }
  }
}

main().catch(console.error);
