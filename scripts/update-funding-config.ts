/**
 * Update funding config to Binance-like parameters
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeUpdateConfig } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_UPDATE_CONFIG } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  console.log('=== Updating Funding Config to Binance-like Parameters ===\n');
  console.log('Admin:', payer.publicKey.toBase58());
  console.log('Slab:', SLAB.toBase58());
  console.log('');

  // New Binance-like parameters
  const configArgs = {
    // Funding params - adjusted for meaningful rates at our market size
    fundingHorizonSlots: 500n,
    fundingKBps: 100n,
    fundingInvScaleNotionalE6: 1_000_000_000n,  // Reduced from 1e12 to 1e9
    fundingMaxPremiumBps: 1000n,                // Increased from 500
    fundingMaxBpsPerSlot: 10n,                  // Increased from 5
    // Threshold params - keep defaults
    threshFloor: 0n,
    threshRiskBps: 50n,
    threshUpdateIntervalSlots: 10n,
    threshStepBps: 500n,
    threshAlphaBps: 1000n,
    threshMin: 0n,
    threshMax: 10_000_000_000_000_000_000n,
    threshMinStep: 1n,
  };

  console.log('New funding parameters:');
  console.log('  fundingInvScaleNotionalE6:', configArgs.fundingInvScaleNotionalE6.toString(), '(was 1000000000000)');
  console.log('  fundingMaxPremiumBps:', configArgs.fundingMaxPremiumBps.toString(), '(was 500)');
  console.log('  fundingMaxBpsPerSlot:', configArgs.fundingMaxBpsPerSlot.toString(), '(was 5)');
  console.log('');

  const ixData = encodeUpdateConfig(configArgs);

  const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
    payer.publicKey,
    SLAB,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  tx.add(buildIx({
    programId: PROGRAM_ID,
    keys,
    data: ixData,
  }));

  console.log('Sending transaction...');
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log('Success! Signature:', sig);
  } catch (err: any) {
    console.error('Failed:', err.message);
    if (err.logs) {
      console.error('Logs:', err.logs);
    }
  }
}

main().catch(console.error);
