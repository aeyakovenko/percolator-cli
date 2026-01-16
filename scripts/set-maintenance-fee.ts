/**
 * Set maintenance fee per slot (admin only)
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import { buildIx } from '../src/runtime/tx.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Instruction tag 15 = SetMaintenanceFee
function encodeSetMaintenanceFee(newFee: bigint): Buffer {
  const buf = Buffer.alloc(17); // 1 byte tag + 16 bytes u128
  buf.writeUInt8(15, 0); // tag
  buf.writeBigUInt64LE(newFee & BigInt('0xFFFFFFFFFFFFFFFF'), 1); // lo
  buf.writeBigUInt64LE(newFee >> 64n, 9); // hi
  return buf;
}

async function main() {
  // Set maintenance fee to 1000 lamports per slot (~0.009 SOL per hour)
  const newFee = BigInt(process.argv[2] || '1000');

  console.log('Setting maintenance fee per slot to:', newFee.toString());

  const ixData = encodeSetMaintenanceFee(newFee);

  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: SLAB, isSigner: false, isWritable: true },
  ];

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  console.log('Transaction:', sig);
  console.log('Maintenance fee updated successfully!');
}

main().catch(console.error);
