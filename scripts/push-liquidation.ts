/**
 * Push Trader 5 toward liquidation by increasing their position
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeTradeNoCpi } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_TRADE_NOCPI } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

const TRADER_IDX = 5;
const TRADE_SIZE = 50_000_000_000n; // 50B units

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
  console.log('=== Pushing Trader 5 toward liquidation ===\n');

  // Check current state
  let slabData = await fetchSlab(connection, SLAB);
  let account = parseAccount(slabData, TRADER_IDX);
  if (!account) {
    console.error('Account not found');
    return;
  }

  const currentPos = account.positionSize;
  const capital = Number(account.capital) / 1e9;
  console.log(`Current: pos=${currentPos}, capital=${capital} SOL`);

  // Keep adding LONG position until we hit margin limits or they become liquidatable
  let tradeCount = 0;
  while (tradeCount < 5) {
    try {
      console.log(`\nTrade ${++tradeCount}: Adding ${TRADE_SIZE} LONG units...`);
      await executeTrade(TRADER_IDX, TRADE_SIZE);
      console.log('OK');

      // Check new state
      slabData = await fetchSlab(connection, SLAB);
      account = parseAccount(slabData, TRADER_IDX);
      if (!account) break;

      const newPos = account.positionSize;
      const newCapital = Number(account.capital) / 1e9;
      const notional = Number(newPos) * 7026 / 1e12; // approximate
      const margin = (newCapital / Math.abs(notional)) * 100;

      console.log(`Position: ${newPos}, Capital: ${newCapital} SOL`);
      console.log(`Approx notional: ${notional.toFixed(4)} SOL`);
      console.log(`Approx margin: ${margin.toFixed(2)}%`);

      if (margin < 5) {
        console.log('\n*** Account now LIQUIDATABLE! ***');
        break;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      console.log(`Trade failed: ${err.message}`);
      // Likely hit margin limit - check state
      slabData = await fetchSlab(connection, SLAB);
      account = parseAccount(slabData, TRADER_IDX);
      if (account) {
        console.log(`Final position: ${account.positionSize}`);
      }
      break;
    }
  }

  console.log('\nDone. Run dump-state.ts to see liquidation status.');
}

main().catch(console.error);
