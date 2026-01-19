/**
 * Test why Trader 6's withdrawals fail
 */
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeWithdrawCollateral, encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_KEEPER_CRANK } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount, parseEngine } from '../src/solana/slab.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const ORACLE = new PublicKey(marketInfo.oracle);
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

async function runCranks(count: number) {
  for (let i = 0; i < count; i++) {
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    try {
      await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: 'confirmed' });
    } catch {}
  }
}

async function main() {
  // Run 16 cranks first
  console.log('Running 16 cranks...');
  await runCranks(16);

  // Check engine state for pending socialization
  const slabData = await fetchSlab(conn, SLAB);
  const engine = parseEngine(slabData);
  console.log('\nEngine state:');
  console.log('  pending_profit_to_fund:', engine.pendingProfitToFund?.toString() || 'N/A');
  console.log('  pending_unpaid_loss:', engine.pendingUnpaidLoss?.toString() || 'N/A');
  console.log('  risk_reduction_only:', engine.riskReductionOnly);

  // Check Trader 6's state
  const trader6 = parseAccount(slabData, 6);
  if (!trader6) {
    console.log('\nTrader 6 not found!');
    return;
  }

  console.log('\nTrader 6 state:');
  console.log('  capital:', Number(trader6.capital) / 1e9, 'SOL');
  console.log('  pnl:', Number(trader6.pnl) / 1e9, 'SOL');
  console.log('  position:', trader6.positionSize.toString());
  console.log('  feeCredits:', Number(trader6.feeCredits) / 1e9);
  console.log('  warmupStartedAtSlot:', trader6.warmupStartedAtSlot);
  console.log('  lastFeeSlot:', trader6.lastFeeSlot);

  // Get user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), SLAB.toBuffer()], PROGRAM_ID);

  // Try to withdraw 0.05 SOL
  const amount = 50_000_000n; // 0.05 SOL
  console.log('\nAttempting withdraw', Number(amount) / 1e9, 'SOL from Trader 6...');

  const withdrawData = encodeWithdrawCollateral({ userIdx: 6, amount: amount.toString() });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta.address, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE
  ]);
  const withdrawTx = new Transaction();
  withdrawTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  withdrawTx.add(buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData }));

  try {
    const result = await sendAndConfirmTransaction(conn, withdrawTx, [payer], { commitment: 'confirmed' });
    console.log('SUCCESS:', result);
  } catch (err: any) {
    console.log('FAILED:', err.message);
    if (err.logs) {
      console.log('\nLogs:');
      err.logs.forEach((log: string) => console.log(' ', log));
    }
  }
}

main().catch(console.error);
