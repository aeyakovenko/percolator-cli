/**
 * Raise risk threshold above insurance balance to stress test the system
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
  console.log('=== RAISING RISK THRESHOLD ABOVE INSURANCE BALANCE ===\n');

  // Check current state
  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  const currentInsurance = Number(engine.insuranceFund.balance) / 1e9;
  const currentThreshold = Number(params.riskReductionThreshold) / 1e9;
  const currentSurplus = currentInsurance - currentThreshold;

  console.log('Current state:');
  console.log('  Insurance fund:', currentInsurance.toFixed(4), 'SOL');
  console.log('  Threshold:', currentThreshold.toFixed(4), 'SOL');
  console.log('  Surplus:', currentSurplus.toFixed(4), 'SOL');
  console.log('');

  // Set threshold to 10 SOL (higher than insurance balance of ~7 SOL)
  const NEW_THRESHOLD = 10_000_000_000n; // 10 SOL

  console.log('Setting new threshold to:', Number(NEW_THRESHOLD) / 1e9, 'SOL');
  console.log('Expected new surplus:', (currentInsurance - Number(NEW_THRESHOLD) / 1e9).toFixed(4), 'SOL (NEGATIVE!)');
  console.log('');

  // Use threshFloor to set the minimum threshold
  const configArgs = {
    fundingHorizonSlots: 500n,
    fundingKBps: 100n,
    fundingInvScaleNotionalE6: 1_000_000_000_000n,
    fundingMaxPremiumBps: 500n,
    fundingMaxBpsPerSlot: 5n,
    // Threshold params - set floor to our target threshold
    threshFloor: NEW_THRESHOLD,       // Floor = minimum threshold = 5 SOL
    threshRiskBps: 5000n,             // High risk BPS to keep threshold high
    threshUpdateIntervalSlots: 1n,    // Update every slot
    threshStepBps: 10000n,            // Big steps
    threshAlphaBps: 10000n,           // Full alpha
    threshMin: NEW_THRESHOLD,         // Min = 5 SOL
    threshMax: 10_000_000_000n,       // Max = 10 SOL
    threshMinStep: NEW_THRESHOLD,     // Large min step
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
    console.log('  Insurance fund:', Number(newEngine.insuranceFund.balance) / 1e9, 'SOL');
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
