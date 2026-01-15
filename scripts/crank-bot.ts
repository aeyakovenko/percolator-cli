/**
 * Keeper crank bot - runs continuously to keep the market fresh
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const CRANK_INTERVAL_MS = 5000; // 5 seconds between cranks

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function runCrank(): Promise<string> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: crankData }));
  return await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
}

async function main() {
  console.log('Keeper Crank Bot\n');
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Oracle: ${ORACLE.toBase58()}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}\n`);
  console.log(`Cranking every ${CRANK_INTERVAL_MS / 1000} seconds...\n`);

  let crankCount = 0;
  let errorCount = 0;

  while (true) {
    try {
      const sig = await runCrank();
      crankCount++;
      console.log(`[${new Date().toISOString()}] Crank #${crankCount} OK: ${sig.slice(0, 16)}...`);
    } catch (err: any) {
      errorCount++;
      console.error(`[${new Date().toISOString()}] Crank failed (${errorCount}): ${err.message}`);
    }

    await new Promise(r => setTimeout(r, CRANK_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
