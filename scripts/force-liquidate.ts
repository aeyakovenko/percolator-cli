/**
 * Run full crank cycle then liquidate
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeLiquidateAtOracle, encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_LIQUIDATE_AT_ORACLE, ACCOUNTS_KEEPER_CRANK } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function runCrank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: crankData }));
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
}

async function main() {
  const targetIdx = 5;

  console.log('=== Force Liquidate with Full Crank Cycle ===\n');

  // Check current state
  let slabData = await fetchSlab(connection, SLAB);
  let account = parseAccount(slabData, targetIdx);
  console.log(`Before: pos=${account?.positionSize}, capital=${Number(account?.capital || 0) / 1e9} SOL`);

  // Run full crank cycle (16 steps)
  console.log('\nRunning full crank cycle (16 steps)...');
  for (let i = 0; i < 16; i++) {
    await runCrank();
    process.stdout.write('.');
  }
  console.log(' Done');

  // Refresh state
  slabData = await fetchSlab(connection, SLAB);
  account = parseAccount(slabData, targetIdx);
  console.log(`After crank: pos=${account?.positionSize}, capital=${Number(account?.capital || 0) / 1e9} SOL`);

  // Now try liquidation
  console.log('\nSending liquidation...');
  const ixData = encodeLiquidateAtOracle({ targetIdx });
  const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
      skipPreflight: true,
    });
    console.log('SUCCESS! Signature:', sig);

    // Check final state
    slabData = await fetchSlab(connection, SLAB);
    account = parseAccount(slabData, targetIdx);
    console.log(`After liquidation: pos=${account?.positionSize}, capital=${Number(account?.capital || 0) / 1e9} SOL`);
  } catch (err: any) {
    console.error('FAILED:', err.message);
    if (err.logs) {
      console.error('Logs:', err.logs);
    }
  }
}

main().catch(console.error);
