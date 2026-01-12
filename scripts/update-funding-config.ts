/**
 * Update funding config for the devnet market
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeUpdateConfig } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_UPDATE_CONFIG } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';

const PROGRAM_ID = new PublicKey('AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA');
const SLAB = new PublicKey('8CUcauuMqAiB2xnT5c8VNM4zDHfbsedz6eLTAhHjACTe');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  console.log('Updating funding config...');
  console.log('Slab:', SLAB.toBase58());
  console.log('Admin:', payer.publicKey.toBase58());

  const configArgs = {
    fundingHorizonSlots: 50n,
    fundingKBps: 100n,
    fundingInvScaleNotionalE6: 1000n,  // $0.001 notional scale for small positions
    fundingMaxPremiumBps: 500n,
    fundingMaxBpsPerSlot: 5n,
    // Keep threshold defaults
    threshFloor: 0n,
    threshRiskBps: 50n,
    threshUpdateIntervalSlots: 10n,
    threshStepBps: 500n,
    threshAlphaBps: 1000n,
    threshMin: 0n,
    threshMax: 10_000_000_000_000_000_000n,
    threshMinStep: 1n,
  };

  const ixData = encodeUpdateConfig(configArgs);
  const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [payer.publicKey, SLAB]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  console.log('Config updated!');
  console.log('Signature:', sig);
  console.log('\nNew config:');
  console.log('  Funding Horizon: 50 slots');
  console.log('  Funding K: 100 bps');
  console.log('  Funding Scale: 1000 (e6)');
  console.log('  Max Premium: 500 bps');
  console.log('  Max/Slot: 5 bps');
}

main().catch(console.error);
