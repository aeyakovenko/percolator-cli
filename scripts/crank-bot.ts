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
 * Compute effective position accounting for ADL multiplier adjustments.
 */
function effectivePosQ(
  acc: ReturnType<typeof parseAccount>,
  engine: ReturnType<typeof parseEngine>,
): bigint {
  const basis = acc.positionBasisQ;
  if (basis === 0n) return 0n;
  const isLong = basis > 0n;
  const epochSide = isLong ? engine.adlEpochLong : engine.adlEpochShort;
  if (acc.adlEpochSnap !== epochSide) return 0n;
  const aBasis = acc.adlABasis;
  if (aBasis === 0n) return 0n;
  const aSide = isLong ? engine.adlMultLong : engine.adlMultShort;
  return (basis * BigInt.asIntN(128, aSide)) / BigInt.asIntN(128, aBasis);
}

/**
 * Compute liquidation candidates: ALL accounts with non-zero positions,
 * sorted by leverage (highest first). PnL is stale until crank touches
 * accounts, so we can't filter pre-crank — submit all and let on-chain sort it.
 */
function computeCandidates(data: Buffer, engine: ReturnType<typeof parseEngine>): number[] {
  const indices = parseUsedIndices(data);
  const oraclePrice = engine.lastOraclePrice > 0n ? engine.lastOraclePrice : 1n;
  const POS_SCALE = 1_000_000n;

  const scored: { idx: number; leverage: bigint }[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const effPos = effectivePosQ(acc, engine);
    const absPos = effPos < 0n ? -effPos : effPos;
    if (absPos === 0n) continue;

    const notional = (absPos * oraclePrice) / POS_SCALE;
    const capital = acc.capital > 0n ? acc.capital : 1n;
    const leverage = (notional * 10_000n) / capital;

    scored.push({ idx, leverage });
  }

  scored.sort((a, b) => (b.leverage > a.leverage ? 1 : b.leverage < a.leverage ? -1 : 0));
  return scored.map(s => s.idx);
}

async function runCrank(): Promise<{ sig: string; candidates: number }> {
  const slabData = await fetchSlab(connection, SLAB);
  const engine = parseEngine(slabData);
  const candidates = computeCandidates(slabData, engine);

  const crankData = encodeKeeperCrank({ callerIdx: 65535, candidates });
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
