/**
 * Top up insurance fund to exit risk reduction mode
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { encodeTopUpInsurance } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_TOPUP_INSURANCE } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseEngine, parseParams } from '../src/solana/slab.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  console.log('=== TOP UP INSURANCE FUND ===\n');

  // Check current state
  let data = await fetchSlab(connection, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);

  const currentInsurance = Number(engine.insuranceFund.balance) / 1e9;
  const threshold = Number(params.riskReductionThreshold) / 1e9;

  console.log('Current state:');
  console.log('  Insurance:', currentInsurance.toFixed(4), 'SOL');
  console.log('  Threshold:', threshold.toFixed(4), 'SOL');
  console.log('  Surplus:', (currentInsurance - threshold).toFixed(4), 'SOL');
  console.log('  Risk reduction mode:', engine.riskReductionOnly);

  // Calculate amount needed
  const needed = threshold - currentInsurance + 5; // Add 5 SOL buffer
  const topupAmount = Math.max(needed, 5) * 1e9; // At least 5 SOL

  console.log('\nTopping up:', topupAmount / 1e9, 'SOL');

  // Get user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);
  console.log('User ATA:', userAta.address.toBase58());
  console.log('User ATA balance:', Number(userAta.amount) / 1e9, 'SOL');

  if (Number(userAta.amount) < topupAmount) {
    console.error('Insufficient wrapped SOL in ATA. Need', topupAmount / 1e9, 'SOL');
    console.log('Please wrap more SOL first.');
    return;
  }

  // Build transaction
  const ixData = encodeTopUpInsurance({ amount: BigInt(Math.floor(topupAmount)).toString() });
  const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  tx.add(buildIx({
    programId: PROGRAM_ID,
    keys,
    data: ixData,
  }));

  console.log('\nSending topUpInsurance transaction...');
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log('Success! Signature:', sig);

    // Verify the change
    data = await fetchSlab(connection, SLAB);
    engine = parseEngine(data);
    params = parseParams(data);

    const newInsurance = Number(engine.insuranceFund.balance) / 1e9;
    const newThreshold = Number(params.riskReductionThreshold) / 1e9;

    console.log('\nNew state:');
    console.log('  Insurance:', newInsurance.toFixed(4), 'SOL');
    console.log('  Threshold:', newThreshold.toFixed(4), 'SOL');
    console.log('  Surplus:', (newInsurance - newThreshold).toFixed(4), 'SOL');
    console.log('  Risk reduction mode:', engine.riskReductionOnly);

  } catch (err: any) {
    console.error('Failed:', err.message);
    if (err.logs) {
      console.error('Logs:', err.logs);
    }
  }
}

main().catch(console.error);
