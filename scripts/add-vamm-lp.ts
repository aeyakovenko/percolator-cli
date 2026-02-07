/**
 * Add a vAMM-configured LP to the existing market
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeInitLP, encodeDepositCollateral } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_INIT_LP, ACCOUNTS_DEPOSIT_COLLATERAL } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseUsedIndices } from '../src/solana/slab.js';
import { deriveLpPda } from '../src/solana/pda.js';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM_ID = new PublicKey(marketInfo.matcherProgramId);

const MATCHER_CTX_SIZE = 320; // Minimum context size for percolator

// vAMM parameters
const VAMM_MODE = 1;  // 1 = vAMM mode
const TRADING_FEE_BPS = 5;      // 0.05% trading fee
const BASE_SPREAD_BPS = 10;     // 0.10% base spread
const MAX_TOTAL_BPS = 200;      // 2% max total (spread + impact + fee)
const IMPACT_K_BPS = 100;       // Impact at full liquidity
const LIQUIDITY_NOTIONAL_E6 = 10_000_000_000_000n;  // 10M notional liquidity
const MAX_FILL_ABS = 1_000_000_000_000n;  // Max fill per trade
const MAX_INVENTORY_ABS = 0n;   // No inventory limit (0 = unlimited)

const LP_COLLATERAL = 5_000_000_000n;  // 5 SOL initial collateral

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

/**
 * Encode vAMM init instruction (Tag 2, 66 bytes)
 */
function encodeInitVamm(params: {
  mode: number;
  tradingFeeBps: number;
  baseSpreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
  liquidityNotionalE6: bigint;
  maxFillAbs: bigint;
  maxInventoryAbs: bigint;
}): Buffer {
  const data = Buffer.alloc(66);
  let offset = 0;

  data.writeUInt8(2, offset); offset += 1;  // Tag 2 = InitVamm
  data.writeUInt8(params.mode, offset); offset += 1;
  data.writeUInt32LE(params.tradingFeeBps, offset); offset += 4;
  data.writeUInt32LE(params.baseSpreadBps, offset); offset += 4;
  data.writeUInt32LE(params.maxTotalBps, offset); offset += 4;
  data.writeUInt32LE(params.impactKBps, offset); offset += 4;

  // u128 fields need manual encoding
  const liq = params.liquidityNotionalE6;
  data.writeBigUInt64LE(liq & 0xFFFFFFFFFFFFFFFFn, offset); offset += 8;
  data.writeBigUInt64LE(liq >> 64n, offset); offset += 8;

  const maxFill = params.maxFillAbs;
  data.writeBigUInt64LE(maxFill & 0xFFFFFFFFFFFFFFFFn, offset); offset += 8;
  data.writeBigUInt64LE(maxFill >> 64n, offset); offset += 8;

  const maxInv = params.maxInventoryAbs;
  data.writeBigUInt64LE(maxInv & 0xFFFFFFFFFFFFFFFFn, offset); offset += 8;
  data.writeBigUInt64LE(maxInv >> 64n, offset); offset += 8;

  return data;
}

async function main() {
  console.log('Adding vAMM LP to market\n');
  console.log('Program:', PROGRAM_ID.toBase58());
  console.log('Slab:', SLAB.toBase58());
  console.log('Matcher:', MATCHER_PROGRAM_ID.toBase58());
  console.log('');

  // Get wSOL ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  console.log('User ATA:', userAta.address.toBase58());

  // Get next free LP index
  // NOTE: Percolator uses LIFO freelist, not bitmap scan. This works for fresh
  // markets but may fail after GC frees slots in non-sequential order.
  // For production, read the freelist from slab or use retry logic.
  const slabData = await fetchSlab(conn, SLAB);
  const usedIndices = new Set(parseUsedIndices(slabData));
  let lpIndex = 0;
  while (usedIndices.has(lpIndex)) {
    lpIndex++;
  }
  console.log('Next free LP index:', lpIndex);

  // Derive LP PDA first (needed for matcher init)
  const [lpPda] = deriveLpPda(PROGRAM_ID, SLAB, lpIndex);
  console.log('LP PDA:', lpPda.toBase58());

  // Create matcher context keypair
  const matcherCtxKp = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  console.log('Matcher context:', matcherCtxKp.publicKey.toBase58());

  // Encode vAMM init instruction
  const initVammData = encodeInitVamm({
    mode: VAMM_MODE,
    tradingFeeBps: TRADING_FEE_BPS,
    baseSpreadBps: BASE_SPREAD_BPS,
    maxTotalBps: MAX_TOTAL_BPS,
    impactKBps: IMPACT_K_BPS,
    liquidityNotionalE6: LIQUIDITY_NOTIONAL_E6,
    maxFillAbs: MAX_FILL_ABS,
    maxInventoryAbs: MAX_INVENTORY_ABS,
  });

  // Encode LP init instruction
  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM_ID,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: '2000000',  // 0.002 SOL
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  // ATOMIC COMPOUND TRANSACTION:
  // 1. Create matcher context account
  // 2. Initialize matcher context with LP PDA
  // 3. Initialize LP in percolator
  console.log('\nCreating LP atomically (compound transaction)...');
  const atomicTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    // 1. Create matcher context account
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherRent,
      space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROGRAM_ID,
    }),
    // 2. Initialize matcher context (accounts: [lp_pda, ctx_account])
    {
      programId: MATCHER_PROGRAM_ID,
      keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },  // LP PDA (stored for sig verification)
        { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },  // Matcher context
      ],
      data: initVammData,
    },
    // 3. Initialize LP in percolator
    buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData })
  );

  await sendAndConfirmTransaction(conn, atomicTx, [payer, matcherCtxKp], { commitment: 'confirmed' });
  console.log('   LP created atomically!');
  console.log('   - Matcher context created and initialized');
  console.log('   - LP PDA stored in matcher for signature verification');
  console.log('   - LP initialized at index', lpIndex);

  // Deposit collateral
  console.log('\n5. Depositing', Number(LP_COLLATERAL) / 1e9, 'SOL collateral...');
  const depositData = encodeDepositCollateral({
    userIdx: lpIndex,
    amount: LP_COLLATERAL.toString(),
  });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    new PublicKey('SysvarC1ock11111111111111111111111111111111'),
  ]);

  const depositTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
  );
  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: 'confirmed' });
  console.log('   Deposited!');

  console.log('\n========================================');
  console.log('vAMM LP CREATED SUCCESSFULLY');
  console.log('========================================');
  console.log('LP Index:', lpIndex);
  console.log('LP PDA:', lpPda.toBase58());
  console.log('Matcher Context:', matcherCtxKp.publicKey.toBase58());
  console.log('Collateral:', Number(LP_COLLATERAL) / 1e9, 'SOL');
  console.log('');

  // Update devnet-market.json with new LP info
  marketInfo.vammLp = {
    index: lpIndex,
    pda: lpPda.toBase58(),
    matcherContext: matcherCtxKp.publicKey.toBase58(),
    collateral: Number(LP_COLLATERAL) / 1e9,
    config: {
      mode: 'vAMM',
      tradingFeeBps: TRADING_FEE_BPS,
      baseSpreadBps: BASE_SPREAD_BPS,
      maxTotalBps: MAX_TOTAL_BPS,
      impactKBps: IMPACT_K_BPS,
    },
  };
  fs.writeFileSync('devnet-market.json', JSON.stringify(marketInfo, null, 2));
  console.log('Updated devnet-market.json with vAMM LP info');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
