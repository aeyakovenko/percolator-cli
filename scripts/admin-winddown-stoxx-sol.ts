/**
 * Wind down the mainnet STOXX/SOL market HgpvbLJh… so we can deploy
 * fd98358 (which requires re-init under the new engine's V16Config rules).
 *
 * Steps:
 *   1. ResolveMarket (admin signer)               — mode 0 → 1
 *   2. WithdrawInsurance(remaining)                — drain ~84 lamports dust
 *   3. WithdrawBackingBucket(domain=0, vault_qty) — drain ~20M lamports vault
 *   4. CloseSlab                                   — close the market account
 *
 * Authority: admin (`marketauth`) signs everything. Vault wSOL goes to
 * admin's wSOL ATA; market rent goes to admin.
 *
 * After this we deploy fd98358 + InitMarket a fresh HgpvbLJh-replacement.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encResolveMarket, encWithdrawInsurance, encWithdrawBackingBucket, encCloseSlab,
  MARKET_GROUP_OFF, MG,
} from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");
const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
const PROG = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const VAULT_AUTH = new PublicKey(M.vaultPda);
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

const cu = (limit = 400_000) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

async function send(label: string, ixs: TransactionInstruction[]): Promise<boolean> {
  const tx = new Transaction().add(...cu(), ...ixs);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: true });
    console.log(`  ✅ ${label}: ${sig}`);
    return true;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.log(`  ❌ ${label}: ${msg.slice(0, 300)}`);
    const sigm = msg.match(/Transaction (\w{32,})/);
    if (sigm) {
      await new Promise(r => setTimeout(r, 2500));
      const t = await conn.getTransaction(sigm[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("    logs:", (t?.meta?.logMessages ?? []).slice(-12).join("\n      "));
    }
    return false;
  }
}

function rd128(d: Buffer, off: number): bigint {
  return d.readBigUInt64LE(off) | (d.readBigUInt64LE(off + 8) << 64n);
}

(async () => {
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, VAULT_AUTH, true);

  // Pre-flight
  const ai = await conn.getAccountInfo(MARKET, "confirmed");
  if (!ai) { console.log("market already gone"); return; }
  const d = Buffer.from(ai.data);
  const mode = d[MARKET_GROUP_OFF + MG.mode];
  const vault = rd128(d, MARKET_GROUP_OFF + MG.vault);
  const insurance = rd128(d, MARKET_GROUP_OFF + MG.insurance);
  const cTot = rd128(d, MARKET_GROUP_OFF + MG.c_tot);
  const used = d.readBigUInt64LE(MARKET_GROUP_OFF + MG.materialized_portfolio_count);
  console.log(`market ${MARKET.toBase58()} (${ai.data.length}B)`);
  console.log(`  mode=${mode} vault=${vault} insurance=${insurance} c_tot=${cTot} materializedPortfolios=${used}`);
  if (used > 0n || cTot > 0n) {
    console.log("⚠️  market still has active portfolios; aborting (close them first)");
    process.exit(1);
  }

  // Step 1: ensure source ATA exists (idempotent)
  await send("ensure admin wSOL ATA", [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
  ]);

  // Step 2: ResolveMarket (if Live)
  if (mode === 0) {
    await send("ResolveMarket", [
      new TransactionInstruction({
        programId: PROG, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: MARKET, isSigner: false, isWritable: true },
        ], data: encResolveMarket(),
      }),
    ]);
  } else {
    console.log("  ⏭  market already non-Live, skipping ResolveMarket");
  }

  // Step 3: WithdrawInsurance (drain dust)
  if (insurance > 0n) {
    await send(`WithdrawInsurance(${insurance})`, [
      new TransactionInstruction({
        programId: PROG, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: MARKET, isSigner: false, isWritable: true },
          { pubkey: adminAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: VAULT_AUTH, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdrawInsurance(insurance),
      }),
    ]);
  }

  // Refresh post-resolve vault
  const ai2 = await conn.getAccountInfo(MARKET, "confirmed");
  const d2 = Buffer.from(ai2!.data);
  const vault2 = rd128(d2, MARKET_GROUP_OFF + MG.vault);
  if (vault2 > 0n) {
    await send(`WithdrawBackingBucket(domain=0, ${vault2})`, [
      new TransactionInstruction({
        programId: PROG, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: MARKET, isSigner: false, isWritable: true },
          { pubkey: adminAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: VAULT_AUTH, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdrawBackingBucket({ domain: 0, amount: vault2 }),
      }),
    ]);
  }

  // Step 5: CloseSlab
  await send("CloseSlab", [
    new TransactionInstruction({
      programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: VAULT_AUTH, isSigner: false, isWritable: false },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ], data: encCloseSlab(),
    }),
  ]);

  // Unwrap residual wSOL to native SOL
  const ataInfo = await conn.getAccountInfo(adminAta).catch(() => null);
  if (ataInfo) {
    await send("close wSOL ATA (unwrap to native)", [
      createCloseAccountInstruction(adminAta, admin.publicKey, admin.publicKey),
    ]);
  }

  const after = await conn.getAccountInfo(MARKET, "confirmed");
  console.log(after ? `\n⚠️  market still exists post-close` : `\n✅ market closed cleanly`);
})();
