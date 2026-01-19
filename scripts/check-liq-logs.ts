/**
 * Check liquidation with detailed logs
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeLiquidateAtOracle } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_LIQUIDATE_AT_ORACLE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const targetIdx = 5;

  // Check state before
  let slabData = await fetchSlab(connection, SLAB);
  let account = parseAccount(slabData, targetIdx);
  console.log('=== Before Liquidation ===');
  console.log('Position:', account?.positionSize?.toString());
  console.log('Capital:', Number(account?.capital || 0) / 1e9, 'SOL');
  console.log('PnL:', account?.pnl?.toString());
  console.log('Funding index:', account?.fundingIndex);

  const ixData = encodeLiquidateAtOracle({ targetIdx });
  console.log('\nInstruction data hex:', ixData.toString('hex'));

  const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  console.log('\nSending transaction...');
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log('Signature:', sig);

    // Get tx details
    const txDetails = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    console.log('\nProgram logs:');
    txDetails?.meta?.logMessages?.forEach(log => console.log(' ', log));
  } catch (err: any) {
    console.error('Error:', err.message);
    if (err.logs) {
      console.error('\nLogs:', err.logs);
    }
  }

  // Check state after
  slabData = await fetchSlab(connection, SLAB);
  account = parseAccount(slabData, targetIdx);
  console.log('\n=== After Liquidation ===');
  console.log('Position:', account?.positionSize?.toString());
  console.log('Capital:', Number(account?.capital || 0) / 1e9, 'SOL');
  console.log('PnL:', account?.pnl?.toString());
}

main().catch(console.error);
