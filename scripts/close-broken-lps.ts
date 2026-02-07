/**
 * Close broken LP accounts (LP 2, LP 6, LP 16)
 * These have broken matcher contexts with wrong LP PDA stored.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeWithdrawCollateral, encodeCloseAccount } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_CLOSE_ACCOUNT } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';
import { deriveVaultAuthority } from '../src/solana/pda.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const ORACLE = new PublicKey(marketInfo.oracle);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

// LPs to close (broken matcher contexts)
const BROKEN_LPS = [2, 6, 16];

async function main() {
  console.log('Closing broken LP accounts...\n');

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  console.log('User ATA:', userAta.address.toBase58());

  const slabData = await fetchSlab(conn, SLAB);

  for (const lpIdx of BROKEN_LPS) {
    const account = parseAccount(slabData, lpIdx);

    // Verify we can close
    if (account.positionSize !== 0n) {
      console.log(`LP ${lpIdx}: Has position ${account.positionSize}, skipping`);
      continue;
    }

    if (!account.owner.equals(payer.publicKey)) {
      console.log(`LP ${lpIdx}: Not our account (owner: ${account.owner.toBase58()}), skipping`);
      continue;
    }

    const capital = account.capital;
    console.log(`\nLP ${lpIdx}: Capital = ${Number(capital) / 1e9} SOL`);

    // Derive vault authority PDA (needed for both withdraw and close)
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);

    // Step 1: Withdraw all collateral if any
    if (capital > 0n) {
      console.log(`  Withdrawing ${Number(capital) / 1e9} SOL...`);

      const withdrawData = encodeWithdrawCollateral({
        userIdx: lpIdx,
        amount: capital.toString(),
      });

      const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
        payer.publicKey,     // user
        SLAB,                // slab
        VAULT,               // vault
        userAta.address,     // userAta
        vaultPda,            // vaultPda
        TOKEN_PROGRAM_ID,    // tokenProgram
        SYSVAR_CLOCK_PUBKEY, // clock
        ORACLE,              // oracleIdx
      ]);

      const withdrawTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
        buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
      );

      try {
        const sig = await sendAndConfirmTransaction(conn, withdrawTx, [payer], { commitment: 'confirmed' });
        console.log(`  Withdrawn! Sig: ${sig.slice(0, 20)}...`);
      } catch (err: any) {
        console.log(`  Withdraw failed: ${err.message}`);
        continue;
      }
    }

    // Step 2: Close account
    console.log(`  Closing account...`);

    const closeData = encodeCloseAccount({ userIdx: lpIdx });

    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
      payer.publicKey,     // user
      SLAB,                // slab
      VAULT,               // vault
      userAta.address,     // userAta
      vaultPda,            // vaultPda
      TOKEN_PROGRAM_ID,    // tokenProgram
      SYSVAR_CLOCK_PUBKEY, // clock
      ORACLE,              // oracle
    ]);

    const closeTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData })
    );

    try {
      const sig = await sendAndConfirmTransaction(conn, closeTx, [payer], { commitment: 'confirmed' });
      console.log(`  Closed! Sig: ${sig.slice(0, 20)}...`);
    } catch (err: any) {
      console.log(`  Close failed: ${err.message}`);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
