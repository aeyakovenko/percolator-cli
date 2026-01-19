/**
 * Stress test - run multiple large trades to push positions toward liquidation
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeTradeNoCpi, encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_KEEPER_CRANK } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount, parseUsedIndices } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Large trade sizes to stress the market
const TRADE_SIZE = 50_000_000_000n; // 50B units per trade

async function runCrank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
}

async function executeTrade(userIdx: number, size: bigint): Promise<void> {
  const tradeData = encodeTradeNoCpi({
    userIdx,
    lpIdx: 0,
    size: size.toString(),
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    payer.publicKey,
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
}

async function main() {
  console.log('=== Stress Test: Large Aggressive Trades ===\n');

  // Run initial crank cycle
  console.log('Running initial crank cycle...');
  for (let i = 0; i < 16; i++) {
    await runCrank();
    process.stdout.write('.');
  }
  console.log(' Done\n');

  // Get current state
  const slabData = await fetchSlab(connection, SLAB);
  const usedIndices = parseUsedIndices(slabData);

  // Find traders (indices 1-5, excluding LP at 0)
  const traderIndices = usedIndices.filter(idx => idx > 0 && idx <= 5);
  console.log('Trader indices:', traderIndices);

  // Execute aggressive trades to increase positions
  console.log('\nExecuting large LONG trades to increase SHORT LP position...\n');

  for (let round = 0; round < 3; round++) {
    console.log(`--- Round ${round + 1} ---`);

    for (const idx of traderIndices) {
      const account = parseAccount(slabData, idx);
      if (!account) continue;

      const currentPos = account.positionSize;
      console.log(`Trader ${idx}: current position = ${currentPos}`);

      // Go LONG to offset their SHORT and create LP SHORT position
      try {
        console.log(`  Trading LONG ${TRADE_SIZE} units...`);
        await executeTrade(idx, TRADE_SIZE);
        console.log('  OK');
      } catch (err: any) {
        console.log(`  Failed: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Crank after each round
    console.log('\nRunning crank...');
    for (let i = 0; i < 4; i++) {
      await runCrank();
    }
    console.log('Done\n');

    // Check state
    const newSlabData = await fetchSlab(connection, SLAB);
    const lpAccount = parseAccount(newSlabData, 0);
    console.log(`LP position after round ${round + 1}: ${lpAccount?.positionSize}\n`);
  }

  console.log('\n=== Final State ===');
  const finalSlabData = await fetchSlab(connection, SLAB);
  for (const idx of [0, ...traderIndices]) {
    const account = parseAccount(finalSlabData, idx);
    if (account) {
      console.log(`Account ${idx}: pos=${account.positionSize}, capital=${Number(account.capital) / 1e9} SOL`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
