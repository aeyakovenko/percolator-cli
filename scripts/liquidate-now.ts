/**
 * Manually trigger liquidation of LP account
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeLiquidateAtOracle } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_LIQUIDATE_AT_ORACLE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  // Target index 0 = LP account
  const targetIdx = 0;

  console.log('=== Liquidating LP (index 0) ===');
  console.log('Program:', PROGRAM_ID.toBase58());
  console.log('Slab:', SLAB.toBase58());
  console.log('Oracle:', ORACLE.toBase58());
  console.log('Payer:', payer.publicKey.toBase58());

  const ixData = encodeLiquidateAtOracle({ targetIdx });

  const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    payer.publicKey, // unused but required
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({
    programId: PROGRAM_ID,
    keys,
    data: ixData,
  }));

  console.log('\nSending liquidation transaction...');

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
      skipPreflight: true,
    });
    console.log('SUCCESS! Signature:', sig);
  } catch (err: any) {
    console.error('FAILED:', err.message);
    if (err.logs) {
      console.error('\nProgram logs:');
      err.logs.forEach((log: string) => console.error('  ', log));
    }
  }
}

main().catch(console.error);
