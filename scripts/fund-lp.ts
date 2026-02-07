import "dotenv/config";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeDepositCollateral } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

async function main() {
  const lpIndex = parseInt(process.argv[2] || '6');
  const amount = BigInt(process.argv[3] || '5000000000'); // Default 5 SOL
  
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  
  console.log('Depositing', Number(amount)/1e9, 'SOL to LP', lpIndex);
  
  const depositData = encodeDepositCollateral({
    userIdx: lpIndex,
    amount: amount.toString(),
  });
  
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    new PublicKey('SysvarC1ock11111111111111111111111111111111'),
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
  );
  
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  console.log('Done! Sig:', sig);
}

main().catch(console.error);
