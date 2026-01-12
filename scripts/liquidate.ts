/**
 * Manually liquidate an undercollateralized account
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeLiquidateAtOracle } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_LIQUIDATE_AT_ORACLE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA');
const SLAB = new PublicKey('8CUcauuMqAiB2xnT5c8VNM4zDHfbsedz6eLTAhHjACTe');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const TARGET_IDX = parseInt(process.argv[2] || '2');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  console.log(`Liquidating account index ${TARGET_IDX}...`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  const ixData = encodeLiquidateAtOracle({ targetIdx: TARGET_IDX });

  const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    payer.publicKey,     // unused
    SLAB,                // slab
    SYSVAR_CLOCK_PUBKEY, // clock
    ORACLE,              // oracle
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log(`✓ Liquidation successful! Signature: ${sig}`);
  } catch (err: any) {
    console.error(`✗ Liquidation failed: ${err.message}`);
    if (err.logs) {
      console.error('Logs:', err.logs.join('\n'));
    }
  }
}

main().catch(console.error);
