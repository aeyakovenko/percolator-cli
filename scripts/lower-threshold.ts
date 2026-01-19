/**
 * Lower risk threshold to exit risk reduction mode
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeUpdateConfig } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_UPDATE_CONFIG } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseEngine, parseParams } from '../src/solana/slab.js';

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  console.log('=== LOWERING RISK THRESHOLD ===\n');

  // Check current state
  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  console.log('Current state:');
  console.log('  Insurance:', Number(engine.insuranceFund.balance) / 1e9, 'SOL');
  console.log('  Threshold:', Number(params.riskReductionThreshold) / 1e9, 'SOL');
  console.log('  Risk reduction mode:', engine.riskReductionOnly);

  // Set threshold very low (0.1 SOL) to exit risk reduction mode
  const NEW_THRESHOLD = 100_000_000n; // 0.1 SOL

  console.log('\nSetting new threshold to:', Number(NEW_THRESHOLD) / 1e9, 'SOL');

  const configArgs = {
    fundingHorizonSlots: 500n,
    fundingKBps: 100n,
    fundingInvScaleNotionalE6: 1_000_000_000_000n,
    fundingMaxPremiumBps: 500n,
    fundingMaxBpsPerSlot: 5n,
    // Threshold params - set everything low
    threshFloor: NEW_THRESHOLD,
    threshRiskBps: 10n,               // Very low risk BPS
    threshUpdateIntervalSlots: 1000n, // Slow updates
    threshStepBps: 10n,               // Small steps
    threshAlphaBps: 100n,             // Low alpha
    threshMin: NEW_THRESHOLD,
    threshMax: 1_000_000_000n,        // Max 1 SOL
    threshMinStep: 1n,
  };

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

  console.log('Sending updateConfig transaction...');
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log('Success! Signature:', sig);

    // Verify the change
    const newData = await fetchSlab(connection, SLAB);
    const newParams = parseParams(newData);
    const newEngine = parseEngine(newData);

    console.log('\nNew state:');
    console.log('  Insurance:', Number(newEngine.insuranceFund.balance) / 1e9, 'SOL');
    console.log('  Threshold:', Number(newParams.riskReductionThreshold) / 1e9, 'SOL');
    console.log('  Surplus:', (Number(newEngine.insuranceFund.balance) - Number(newParams.riskReductionThreshold)) / 1e9, 'SOL');
    console.log('  Risk reduction mode:', newEngine.riskReductionOnly);

  } catch (err: any) {
    console.error('Failed:', err.message);
    if (err.logs) {
      console.error('Logs:', err.logs);
    }
  }
}

main().catch(console.error);
