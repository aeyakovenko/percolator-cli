/**
 * Fund LP and insurance fund with more SOL
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SystemProgram } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeDepositCollateral, encodeTopUpInsurance } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_TOPUP_INSURANCE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const VAULT = new PublicKey('AJoTRUUwAb8nB2pwqKhNSKxvbE3GdHHiM9VxpoaBLhVj');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  // Target amounts
  const LP_TARGET = 10_000_000_000n;  // 10 SOL
  const INSURANCE_TARGET = 100_000_000_000n;  // 100 SOL

  // Current amounts (from setup script)
  const LP_CURRENT = 100_000_000n;  // 0.1 SOL
  const INSURANCE_CURRENT = 101_000_000n;  // ~0.101 SOL

  const lpDeposit = LP_TARGET - LP_CURRENT;  // 9.9 SOL
  const insuranceDeposit = INSURANCE_TARGET - INSURANCE_CURRENT;  // ~99.9 SOL

  console.log('=== Funding Market ===');
  console.log(`LP deposit needed: ${Number(lpDeposit) / 1e9} SOL`);
  console.log(`Insurance deposit needed: ${Number(insuranceDeposit) / 1e9} SOL`);
  console.log(`Total: ${Number(lpDeposit + insuranceDeposit) / 1e9} SOL\n`);

  // Get/create wrapped SOL ATA
  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);

  // Check wrapped SOL balance
  const balance = await connection.getTokenAccountBalance(userAta.address);
  const needed = Number(lpDeposit + insuranceDeposit) / 1e9 + 0.1; // extra for fees

  console.log(`Wrapped SOL balance: ${balance.value.uiAmount} SOL`);
  console.log(`Needed: ~${needed.toFixed(2)} SOL\n`);

  if (balance.value.uiAmount! < needed) {
    // Wrap more SOL
    const wrapAmount = Math.ceil(needed - balance.value.uiAmount!) * 1e9 + 100_000_000; // extra buffer
    console.log(`Wrapping ${wrapAmount / 1e9} SOL...`);

    const wrapTx = new Transaction();
    wrapTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
    wrapTx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userAta.address,
      lamports: wrapAmount,
    }));
    wrapTx.add({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: userAta.address, isSigner: false, isWritable: true }],
      data: Buffer.from([17]), // SyncNative
    });
    await sendAndConfirmTransaction(connection, wrapTx, [payer], { commitment: 'confirmed' });
    console.log('Wrapped SOL OK\n');
  }

  // Deposit to LP (index 0)
  console.log('Depositing to LP...');
  const depositData = encodeDepositCollateral({ userIdx: 0, amount: lpDeposit.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: 'confirmed' });
  console.log(`Deposited ${Number(lpDeposit) / 1e9} SOL to LP\n`);

  // Top up insurance
  console.log('Topping up insurance fund...');
  const topupData = encodeTopUpInsurance({ amount: insuranceDeposit.toString() });
  const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  const topupTx = new Transaction();
  topupTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  topupTx.add(buildIx({ programId: PROGRAM_ID, keys: topupKeys, data: topupData }));
  await sendAndConfirmTransaction(connection, topupTx, [payer], { commitment: 'confirmed' });
  console.log(`Topped up insurance with ${Number(insuranceDeposit) / 1e9} SOL\n`);

  console.log('=== Done ===');
  console.log('Run: npx tsx scripts/show-state.ts to verify');
}

main().catch(console.error);
