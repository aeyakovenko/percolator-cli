/**
 * Test trading on the new wrapped SOL market
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction, PublicKey, SystemProgram } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeInitUser, encodeDepositCollateral, encodeTradeNoCpi, encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_KEEPER_CRANK } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { parseUsedIndices, parseAccount } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');
const VAULT = new PublicKey('AJoTRUUwAb8nB2pwqKhNSKxvbE3GdHHiM9VxpoaBLhVj');

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  // Run a full crank cycle (16 steps) to ensure sweep is fresh
  console.log('Running full keeper crank cycle (16 steps)...');
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  for (let i = 0; i < 16; i++) {
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: 'confirmed', skipPreflight: true });
    process.stdout.write('.');
  }
  console.log(' Done');

  // Get or create wrapped SOL ATA
  console.log('Setting up wrapped SOL account...');
  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);
  console.log('User ATA:', userAta.address.toBase58());

  // Wrap some SOL if needed
  const balance = await connection.getTokenAccountBalance(userAta.address);
  console.log('Wrapped SOL balance:', balance.value.uiAmount);

  if (balance.value.uiAmount! < 0.1) {
    console.log('Wrapping 0.2 SOL...');
    const wrapTx = new Transaction();
    wrapTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
    wrapTx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userAta.address,
      lamports: 200_000_000, // 0.2 SOL
    }));
    wrapTx.add({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: userAta.address, isSigner: false, isWritable: true }],
      data: Buffer.from([17]), // SyncNative
    });
    await sendAndConfirmTransaction(connection, wrapTx, [payer], { commitment: 'confirmed' });
    console.log('Wrapped SOL OK');
  }

  // Check if user already has an account
  const slabInfo = await connection.getAccountInfo(SLAB);
  if (!slabInfo) throw new Error('Slab not found');

  const usedIndices = parseUsedIndices(slabInfo.data);
  console.log('Used indices:', usedIndices);

  // Find user's account or create one
  let userIdx = -1;
  for (const idx of usedIndices) {
    const account = parseAccount(slabInfo.data, idx);
    if (account && account.owner.equals(payer.publicKey) && account.kind === 0) {
      userIdx = idx;
      console.log('Found existing user account at index:', userIdx);
      break;
    }
  }

  if (userIdx < 0) {
    // Init user
    console.log('Initializing new user account...');
    const initUserData = encodeInitUser({ feePayment: '1000000' }); // 0.001 SOL
    const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      payer.publicKey,
      SLAB,
      userAta.address,
      VAULT,
      TOKEN_PROGRAM_ID,
    ]);
    const initUserTx = new Transaction();
    initUserTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    initUserTx.add(buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData }));
    await sendAndConfirmTransaction(connection, initUserTx, [payer], { commitment: 'confirmed' });

    // Re-fetch indices
    const newSlabInfo = await connection.getAccountInfo(SLAB);
    const newUsedIndices = parseUsedIndices(newSlabInfo!.data);
    userIdx = newUsedIndices[newUsedIndices.length - 1];
    console.log('User account created at index:', userIdx);
  }

  // Deposit collateral
  console.log('Depositing 0.05 SOL collateral...');
  const depositData = encodeDepositCollateral({ userIdx, amount: '50000000' }); // 0.05 SOL
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);
  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: 'confirmed' });
  console.log('Deposit OK');

  // Run another full crank cycle to ensure fresh state before trading
  console.log('Running another keeper crank cycle (16 steps)...');
  for (let i = 0; i < 16; i++) {
    const crank2Tx = new Transaction();
    crank2Tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    crank2Tx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crank2Tx, [payer], { commitment: 'confirmed', skipPreflight: true });
    process.stdout.write('.');
  }
  console.log(' Done');

  // Trade: long 1000 units against LP (index 0)
  console.log('Trading: long 1000 units...');
  const tradeData = encodeTradeNoCpi({
    userIdx,
    lpIdx: 0,
    size: '1000',
  });
  // TradeNoCpi needs: user, lpOwner, slab, clock, oracle
  // Since we own the LP too, both signers are the payer
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    payer.publicKey,  // user
    payer.publicKey,  // lpOwner (we own the LP too)
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);
  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));

  const tradeSig = await sendAndConfirmTransaction(connection, tradeTx, [payer], { commitment: 'confirmed', skipPreflight: true });
  console.log('Trade OK:', tradeSig);

  // Check final state
  const finalSlabInfo = await connection.getAccountInfo(SLAB);
  const userAccount = parseAccount(finalSlabInfo!.data, userIdx);
  const lpAccount = parseAccount(finalSlabInfo!.data, 0);

  console.log('\n=== Final State ===');
  console.log('User (idx', userIdx + '):');
  console.log('  Position:', userAccount?.position.toString());
  console.log('  Capital:', userAccount?.capital.toString());
  console.log('LP (idx 0):');
  console.log('  Position:', lpAccount?.position.toString());
  console.log('  Capital:', lpAccount?.capital.toString());
}

main().catch(console.error);
