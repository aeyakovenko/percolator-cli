/**
 * Close old slab accounts - first withdraws and closes all accounts, then closes slab
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeCloseSlab, encodeWithdrawCollateral, encodeCloseAccount, encodePushOraclePrice, encodeKeeperCrank } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_CLOSE_SLAB, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_CLOSE_ACCOUNT } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseUsedIndices, parseAccount, parseConfig } from '../src/solana/slab.js';
import { deriveVaultAuthority } from '../src/solana/pda.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const OLD_SLAB = new PublicKey('BJVDPj2CKNr1a7ZHhZRaJsRA8Y71q3RScA783JVx6qAj');

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));

async function main() {
  console.log('Closing old hyperp slab...');
  console.log('Slab:', OLD_SLAB.toBase58());

  const slabInfo = await conn.getAccountInfo(OLD_SLAB);
  if (!slabInfo) {
    console.log('Slab not found');
    return;
  }
  console.log('Balance:', slabInfo.lamports / 1e9, 'SOL');

  // Get slab data
  const slabData = await fetchSlab(conn, OLD_SLAB);
  const config = parseConfig(slabData);
  const vault = config.vaultPubkey;
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, OLD_SLAB);

  // Get admin ATA
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);

  // Find all accounts
  const indices = parseUsedIndices(slabData);
  console.log('Used accounts:', indices.length);

  // Close each account
  for (const idx of indices) {
    const acc = parseAccount(slabData, idx);
    if (!acc) continue;

    console.log(`\nAccount ${idx}: capital=${Number(acc.capital)/1e9} SOL, pos=${acc.positionSize}`);

    // Withdraw if has capital
    if (acc.capital > 0n) {
      try {
        const withdrawData = encodeWithdrawCollateral({ userIdx: idx, amount: acc.capital.toString() });
        const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
          admin.publicKey, OLD_SLAB, vault, adminAta.address, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, OLD_SLAB,
        ]);
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
        );
        await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
        console.log('  Withdrawn');
      } catch (e: any) {
        console.log('  Withdraw failed:', e.message?.slice(0, 50));
      }
    }

    // Close account
    try {
      const closeData = encodeCloseAccount({ userIdx: idx });
      const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
        admin.publicKey, OLD_SLAB, vault, adminAta.address, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, OLD_SLAB,
      ]);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData })
      );
      await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
      console.log('  Closed');
    } catch (e: any) {
      console.log('  Close failed:', e.message?.slice(0, 50));
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Now close slab
  console.log('\nClosing slab...');
  const closeSlabData = encodeCloseSlab();
  const closeSlabKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [admin.publicKey, OLD_SLAB]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    buildIx({ programId: PROGRAM_ID, keys: closeSlabKeys, data: closeSlabData })
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
    console.log('Closed! Sig:', sig);
  } catch (e: any) {
    console.log('Close slab failed:', e.message?.slice(0, 80));
  }

  console.log('New balance:', (await conn.getBalance(admin.publicKey)) / 1e9, 'SOL');
}

main().catch(console.error);
