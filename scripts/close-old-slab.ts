/**
 * Close old slab with unsafe_close feature (skips vault/insurance validation)
 */
import "dotenv/config";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeCloseSlab } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_CLOSE_SLAB } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const OLD_SLAB = new PublicKey('BJVDPj2CKNr1a7ZHhZRaJsRA8Y71q3RScA783JVx6qAj');

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));

async function main() {
  console.log('Closing old slab with unsafe_close...');
  console.log('Slab:', OLD_SLAB.toBase58());

  const balanceBefore = await conn.getBalance(admin.publicKey);
  console.log('Balance before:', balanceBefore / 1e9, 'SOL');

  const slabInfo = await conn.getAccountInfo(OLD_SLAB);
  if (!slabInfo) {
    console.log('Slab already closed!');
    return;
  }
  console.log('Slab balance:', slabInfo.lamports / 1e9, 'SOL');

  const closeData = encodeCloseSlab();
  const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [admin.publicKey, OLD_SLAB]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData })
  );

  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
  console.log('Closed! Sig:', sig);

  const balanceAfter = await conn.getBalance(admin.publicKey);
  console.log('Balance after:', balanceAfter / 1e9, 'SOL');
  console.log('Recovered:', (balanceAfter - balanceBefore) / 1e9, 'SOL');
}

main().catch(e => console.error('Error:', e.message));
