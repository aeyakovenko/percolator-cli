/**
 * Set maintenance fee per slot to clean out inactive accounts
 */
import "dotenv/config";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeSetMaintenanceFee } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_SET_MAINTENANCE_FEE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

// Calculate fee to drain 0.1 SOL in 24 hours
// 24 hours ≈ 216,000 slots (at 400ms/slot)
// 0.1 SOL = 100,000,000 lamports
// fee_per_slot = 100,000,000 / 216,000 ≈ 463 lamports
const TARGET_DRAIN_SOL = 0.1;
const HOURS_24_SLOTS = 216_000n;
const FEE_PER_SLOT = BigInt(Math.ceil((TARGET_DRAIN_SOL * 1e9) / Number(HOURS_24_SLOTS)));

async function main() {
  console.log('Setting Maintenance Fee');
  console.log('=======================');
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log('');
  console.log(`Fee per slot: ${FEE_PER_SLOT} lamports`);
  console.log(`This drains ~${TARGET_DRAIN_SOL} SOL per 24 hours from every account`);
  console.log('');

  // Build instruction
  const data = encodeSetMaintenanceFee({ newFee: FEE_PER_SLOT.toString() });
  const keys = buildAccountMetas(ACCOUNTS_SET_MAINTENANCE_FEE, [
    admin.publicKey,  // admin (signer)
    SLAB,             // slab (writable)
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );

  console.log('Sending transaction...');
  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
  console.log(`Success! Signature: ${sig}`);
  console.log('');
  console.log('Drain times at this fee rate:');
  console.log('  0.01 SOL account: ~2.4 hours');
  console.log('  0.1 SOL account:  ~24 hours');
  console.log('  1 SOL account:    ~10 days');
  console.log('  5 SOL account:    ~50 days');
  console.log('  15 SOL account:   ~150 days');
}

main().catch(console.error);
