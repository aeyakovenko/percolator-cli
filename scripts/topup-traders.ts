/**
 * Top up all traders with 1 SOL each
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SystemProgram } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeDepositCollateral } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const VAULT = new PublicKey('AJoTRUUwAb8nB2pwqKhNSKxvbE3GdHHiM9VxpoaBLhVj');

const DEPOSIT_AMOUNT = 1_000_000_000n; // 1 SOL
const TRADER_INDICES = [1, 2, 3, 4, 5];

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function wrapSol(amount: bigint, ata: PublicKey): Promise<void> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: ata,
    lamports: Number(amount),
  }));
  tx.add({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
    data: Buffer.from([17]), // SyncNative
  });
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
}

async function main() {
  console.log('=== Topping Up All Traders with 1 SOL Each ===\n');

  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);

  // Check balance and wrap more if needed
  const balance = await connection.getTokenAccountBalance(userAta.address);
  const needed = Number(DEPOSIT_AMOUNT * BigInt(TRADER_INDICES.length)) / 1e9 + 0.1;

  if (balance.value.uiAmount! < needed) {
    const wrapAmount = BigInt(Math.ceil((needed - balance.value.uiAmount! + 0.5) * 1e9));
    console.log(`Wrapping ${Number(wrapAmount) / 1e9} SOL...`);
    await wrapSol(wrapAmount, userAta.address);
  }

  for (const idx of TRADER_INDICES) {
    console.log(`Depositing 1 SOL to Trader ${idx}...`);

    const depositData = encodeDepositCollateral({ userIdx: idx, amount: DEPOSIT_AMOUNT.toString() });
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

    try {
      await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: 'confirmed' });
      console.log(`  Done!`);
    } catch (err: any) {
      console.error(`  Failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\nAll traders topped up!');
}

main().catch(console.error);
