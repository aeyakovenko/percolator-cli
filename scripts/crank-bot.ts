/**
 * Keeper crank bot - runs continuously with off-chain liquidation candidates
 */
import "dotenv/config";
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseUsedIndices, parseAccount, parseEngine, parseParams } from '../src/solana/slab.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);

const CRANK_INTERVAL_MS = 2000; // 2 seconds between cranks

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

/**
 * Compute liquidation candidates: accounts below maintenance margin, sorted by shortfall.
 */
function computeCandidates(data: Buffer, oraclePrice: bigint): number[] {
  const indices = parseUsedIndices(data);
  const params = parseParams(data);
  const mmBps = params.maintenanceMarginBps;

  const scored: { idx: number; shortfall: bigint }[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const posQ = acc.positionBasisQ < 0n ? -acc.positionBasisQ : acc.positionBasisQ;
    if (posQ === 0n) continue;

    const notional = (posQ * oraclePrice) / 1_000_000n;
    const mmReq = (notional * mmBps) / 10_000n;
    const equity = BigInt.asIntN(128, acc.capital) + acc.pnl;

    if (equity < mmReq) {
      scored.push({ idx, shortfall: mmReq - equity });
    }
  }

  scored.sort((a, b) => (b.shortfall > a.shortfall ? 1 : b.shortfall < a.shortfall ? -1 : 0));
  return scored.map(s => s.idx);
}

async function runCrank(): Promise<{ sig: string; candidates: number }> {
  // Fetch slab and compute candidates off-chain
  const slabData = await fetchSlab(connection, SLAB);
  const engine = parseEngine(slabData);
  const price = engine.lastOraclePrice > 0n ? engine.lastOraclePrice : 1n;
  const candidates = computeCandidates(slabData, price);

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false, candidates });
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: crankData }));
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
  return { sig, candidates: candidates.length };
}

async function main() {
  console.log('Keeper Crank Bot (two-phase with off-chain candidates)\n');
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Oracle: ${ORACLE.toBase58()}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}\n`);
  console.log(`Cranking every ${CRANK_INTERVAL_MS / 1000} seconds...\n`);

  let crankCount = 0;
  let errorCount = 0;

  while (true) {
    try {
      const { sig, candidates } = await runCrank();
      crankCount++;
      const candStr = candidates > 0 ? ` (${candidates} liq candidates)` : '';
      console.log(`[${new Date().toISOString()}] Crank #${crankCount} OK${candStr}: ${sig.slice(0, 16)}...`);
    } catch (err: any) {
      errorCount++;
      console.error(`[${new Date().toISOString()}] Crank failed (${errorCount}): ${err.message}`);
    }

    await new Promise(r => setTimeout(r, CRANK_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
