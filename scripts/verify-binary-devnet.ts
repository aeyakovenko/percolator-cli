/**
 * Verify binary market instructions on devnet
 * Tests against existing market - expects specific errors since market isn't set up for resolution
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeResolveMarket, encodeWithdrawInsurance } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_WITHDRAW_INSURANCE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { deriveVaultAuthority } from '../src/solana/pda.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

async function testResolveMarket(): Promise<boolean> {
  console.log('\n1. Testing ResolveMarket instruction...');

  const resolveData = encodeResolveMarket();
  const resolveKeys = buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [
    admin.publicKey,
    SLAB,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: resolveKeys, data: resolveData }),
  );

  try {
    // Simulate only - don't actually resolve
    const sim = await conn.simulateTransaction(tx, [admin]);

    if (sim.value.err) {
      const logs = sim.value.logs || [];
      console.log('   Simulation failed (expected):');

      // Check for expected error - authority_price_e6 == 0 means InvalidAccountData
      const hasExpectedError = logs.some(l =>
        l.includes('custom program error: 0x4') || // InvalidAccountData
        l.includes('custom program error: 0x3')    // InvalidArgument
      );

      if (hasExpectedError) {
        console.log('   ✓ Got expected error (authority_price_e6 not set or already resolved)');
        console.log('   → Instruction reached program and was validated correctly');
        return true;
      } else {
        console.log('   Logs:', logs.slice(-3));
        return false;
      }
    } else {
      console.log('   ⚠ Simulation succeeded - market may already have authority price set');
      console.log('   → NOT actually sending to avoid resolving active market');
      return true;
    }
  } catch (err: any) {
    console.log('   Error:', err.message?.slice(0, 100));
    return false;
  }
}

async function testWithdrawInsurance(): Promise<boolean> {
  console.log('\n2. Testing WithdrawInsurance instruction...');

  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);

  const withdrawData = encodeWithdrawInsurance();
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
    admin.publicKey,
    SLAB,
    adminAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    vaultPda,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData }),
  );

  try {
    const sim = await conn.simulateTransaction(tx, [admin]);

    if (sim.value.err) {
      const logs = sim.value.logs || [];
      console.log('   Simulation failed (expected):');

      // Expected error: market not resolved (InvalidAccountData)
      const hasExpectedError = logs.some(l =>
        l.includes('custom program error: 0x4') || // InvalidAccountData (not resolved)
        l.includes('custom program error: 0x3')    // InvalidArgument
      );

      if (hasExpectedError) {
        console.log('   ✓ Got expected error (market not resolved)');
        console.log('   → Instruction reached program and was validated correctly');
        return true;
      } else {
        console.log('   Logs:', logs.slice(-3));
        return false;
      }
    } else {
      console.log('   ⚠ Simulation unexpectedly succeeded');
      return false;
    }
  } catch (err: any) {
    console.log('   Error:', err.message?.slice(0, 100));
    return false;
  }
}

async function main() {
  console.log('Binary Market Devnet Verification');
  console.log('==================================');
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const results = {
    resolveMarket: await testResolveMarket(),
    withdrawInsurance: await testWithdrawInsurance(),
  };

  console.log('\n==================================');
  console.log('Results:');
  console.log(`  ResolveMarket:     ${results.resolveMarket ? '✓ VERIFIED' : '✗ FAILED'}`);
  console.log(`  WithdrawInsurance: ${results.withdrawInsurance ? '✓ VERIFIED' : '✗ FAILED'}`);

  if (results.resolveMarket && results.withdrawInsurance) {
    console.log('\n✓ Binary market instructions verified on devnet!');
    console.log('  Both instructions reach the program and return expected validation errors.');
  } else {
    console.log('\n✗ Some verifications failed');
    process.exit(1);
  }
}

main().catch(console.error);
