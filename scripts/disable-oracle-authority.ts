/**
 * Disable oracle authority - reverts to Chainlink prices
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeSetOracleAuthority } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_SET_ORACLE_AUTHORITY } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

async function main() {
  console.log('Disabling oracle authority...');
  console.log('Slab:', SLAB.toBase58());

  const ixData = encodeSetOracleAuthority({
    newAuthority: '11111111111111111111111111111111'  // Zero address = disable
  });

  const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
    payer.publicKey,
    SLAB,
  ]);

  const txn = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
    buildIx({ programId: PROGRAM_ID, keys, data: ixData })
  );

  const sig = await sendAndConfirmTransaction(conn, txn, [payer], { commitment: 'confirmed' });
  console.log('Success! Oracle authority disabled.');
  console.log('Signature:', sig);
  console.log('Explorer:', `https://explorer.solana.com/tx/${sig}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
