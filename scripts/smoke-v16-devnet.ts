/**
 * v16 devnet smoke: InitMarket → InitPortfolio → Deposit → Withdraw → ClosePortfolio.
 *
 * Goal: validate that Deposit / Withdraw now move SPL tokens (the v13 ledger
 * bug fix in v16). After Deposit, vault SPL balance must equal engine ledger.
 *
 * Program: Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG (v16 wrapper)
 * Engine pin: a4aed26ce89ed0ce41c414f085d88e537e9564b6
 * Wrapper commit: 95250b3 ("Bump v16 engine and cover source backing conversion")
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const MARKET_ACCOUNT_LEN = 20_125;
const PORTFOLIO_ACCOUNT_LEN = 7_320;

const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

// ---------- Wire encoding (matches src/v16_program.rs decode) ----------
function u8(v: number): Buffer { const b = Buffer.alloc(1); b.writeUInt8(v, 0); return b; }
function u16le(v: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32le(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function u64le(v: bigint | number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function i64le(v: bigint | number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v), 0); return b; }
function u128le(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b;
}
function i128le(v: bigint): Buffer {
  const u = v < 0n ? (1n << 128n) + v : v;
  return u128le(u);
}

// tag=0 InitMarket
function encInitMarket(p: {
  h_min: bigint, h_max: bigint, initial_price: bigint,
  min_nonzero_mm_req: bigint, min_nonzero_im_req: bigint,
  maintenance_margin_bps: bigint, initial_margin_bps: bigint,
  max_trading_fee_bps: bigint, trade_fee_base_bps: bigint,
  liquidation_fee_bps: bigint, liquidation_fee_cap: bigint,
  min_liquidation_abs: bigint,
  max_price_move_bps_per_slot: bigint, max_accrual_dt_slots: bigint,
  max_abs_funding_e9_per_slot: bigint, min_funding_lifetime_slots: bigint,
  max_account_b_settlement_chunks: bigint, max_bankrupt_close_chunks: bigint,
  public_b_chunk_atoms: bigint, maintenance_fee_per_slot: bigint,
}): Buffer {
  return Buffer.concat([
    u8(0),
    u64le(p.h_min), u64le(p.h_max), u64le(p.initial_price),
    u128le(p.min_nonzero_mm_req), u128le(p.min_nonzero_im_req),
    u64le(p.maintenance_margin_bps), u64le(p.initial_margin_bps),
    u64le(p.max_trading_fee_bps), u64le(p.trade_fee_base_bps),
    u64le(p.liquidation_fee_bps), u128le(p.liquidation_fee_cap),
    u128le(p.min_liquidation_abs),
    u64le(p.max_price_move_bps_per_slot), u64le(p.max_accrual_dt_slots),
    u64le(p.max_abs_funding_e9_per_slot), u64le(p.min_funding_lifetime_slots),
    u64le(p.max_account_b_settlement_chunks), u64le(p.max_bankrupt_close_chunks),
    u128le(p.public_b_chunk_atoms), u128le(p.maintenance_fee_per_slot),
  ]);
}
function encInitPortfolio(): Buffer { return u8(1); }
function encDeposit(amount: bigint): Buffer { return Buffer.concat([u8(3), u128le(amount)]); }
function encWithdraw(amount: bigint): Buffer { return Buffer.concat([u8(4), u128le(amount)]); }
function encClosePortfolio(): Buffer { return u8(8); }
function encCloseSlab(): Buffer { return u8(13); }

function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}

const withCu = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  // v16 boxes ~19K MarketGroup + ~7K Portfolio on the heap; bump from 32K default.
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

async function snap(label: string, market: PublicKey, vaultAta: PublicKey | null) {
  const mInfo = await conn.getAccountInfo(market, "confirmed");
  let vaultBal: bigint | null = null;
  if (vaultAta) {
    try { vaultBal = (await getAccount(conn, vaultAta, "confirmed")).amount; } catch { vaultBal = null; }
  }
  console.log(`[${label}] market_size=${mInfo?.data.length ?? "?"} vault_SPL=${vaultBal !== null ? vaultBal.toString() : "(no ATA)"}`);
}

async function main() {
  console.log("v16 devnet smoke");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  admin:  ", admin.publicKey.toBase58());
  console.log("  balance:", (await conn.getBalance(admin.publicKey)) / 1e9, "SOL");

  const market = Keypair.generate();
  const portfolio = Keypair.generate();
  console.log("  market: ", market.publicKey.toBase58());
  console.log("  port.:  ", portfolio.publicKey.toBase58());

  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  console.log("  vault PDA:", vaultAuth.toBase58());

  // Pre-derive ATAs
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  console.log("  source ATA:", sourceAta.toBase58());
  console.log("  vault  ATA:", vaultAta.toBase58());

  // 1. Create market account (signed by market keypair)
  console.log("\n--- [1] Create market account ---");
  {
    const rent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
    const tx = new Transaction()
      .add(...withCu(50_000))
      .add(SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: market.publicKey,
        lamports: rent,
        space: MARKET_ACCOUNT_LEN,
        programId: PROGRAM_ID,
      }));
    const sig = await sendAndConfirmTransaction(conn, tx, [admin, market], { commitment: "confirmed" });
    console.log("  sig:", sig);
    console.log(`  rent: ${rent / 1e9} SOL`);
  }
  await snap("post-create-market", market.publicKey, null);

  // 2. InitMarket
  console.log("\n--- [2] InitMarket ---");
  {
    const data = encInitMarket({
      h_min: 0n, h_max: 6_480_000n,
      initial_price: 1_000_000n,       // mark = 1.0 SOL per unit
      min_nonzero_mm_req: 500n, min_nonzero_im_req: 600n,
      maintenance_margin_bps: 500n, initial_margin_bps: 500n,
      max_trading_fee_bps: 10_000n, trade_fee_base_bps: 1n,
      liquidation_fee_bps: 5n, liquidation_fee_cap: 50_000_000_000n,
      min_liquidation_abs: 0n,
      max_price_move_bps_per_slot: 49n, max_accrual_dt_slots: 10n,
      max_abs_funding_e9_per_slot: 1_000n, min_funding_lifetime_slots: 10_000_000n,
      max_account_b_settlement_chunks: 16n, max_bankrupt_close_chunks: 16n,
      public_b_chunk_atoms: 1_000_000n, maintenance_fee_per_slot: 58n,
    });
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new Transaction().add(...withCu(400_000)).add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: false });
    console.log("  sig:", sig);
  }
  await snap("post-InitMarket", market.publicKey, null);

  // 3. Create portfolio account
  console.log("\n--- [3] Create portfolio account ---");
  {
    const rent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
    const tx = new Transaction()
      .add(...withCu(50_000))
      .add(SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: portfolio.publicKey,
        lamports: rent,
        space: PORTFOLIO_ACCOUNT_LEN,
        programId: PROGRAM_ID,
      }));
    const sig = await sendAndConfirmTransaction(conn, tx, [admin, portfolio], { commitment: "confirmed" });
    console.log("  sig:", sig, ` rent: ${rent / 1e9} SOL`);
  }

  // 4. InitPortfolio
  console.log("\n--- [4] InitPortfolio ---");
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
      ],
      data: encInitPortfolio(),
    });
    const tx = new Transaction().add(...withCu(200_000)).add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    console.log("  sig:", sig);
  }

  // 5. Wrap SOL into source ATA + create vault ATA
  console.log("\n--- [5] Wrap SOL + create vault ATA ---");
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);  // source
  {
    const tx = new Transaction()
      .add(...withCu(50_000))
      .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
      .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 200_000_000 }))
      .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
             programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) /* SyncNative */ });
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    console.log("  sig:", sig);
  }
  await snap("post-wrap", market.publicKey, vaultAta);

  // 6. Deposit 100M lamports
  const DEPOSIT = 100_000_000n;
  console.log(`\n--- [6] Deposit ${DEPOSIT} lamports ---`);
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encDeposit(DEPOSIT),
    });
    const tx = new Transaction().add(...withCu(400_000)).add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: false });
    console.log("  sig:", sig);
  }
  await snap("post-Deposit", market.publicKey, vaultAta);

  // 7. Withdraw 50M lamports
  const WITHDRAW = 50_000_000n;
  console.log(`\n--- [7] Withdraw ${WITHDRAW} lamports ---`);
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encWithdraw(WITHDRAW),
    });
    const tx = new Transaction().add(...withCu(400_000)).add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    console.log("  sig:", sig);
  }
  await snap("post-Withdraw", market.publicKey, vaultAta);

  // (skip last withdraw + close so a portfolio with capital remains on chain for parser verification)
  if (process.env.LEAVE_OPEN) {
    console.log("\nLEAVE_OPEN=1 → stopping here so v16-inspect can read a non-empty portfolio.");
    return;
  }

  // 8. Withdraw remainder + ClosePortfolio
  console.log("\n--- [8] Withdraw remainder + ClosePortfolio ---");
  {
    const ix1 = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encWithdraw(DEPOSIT - WITHDRAW),
    });
    const tx = new Transaction().add(...withCu(400_000)).add(ix1);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    console.log("  Withdraw rest sig:", sig);
  }
  await snap("post-withdraw-rest", market.publicKey, vaultAta);

  // ClosePortfolio
  {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
      ],
      data: encClosePortfolio(),
    });
    const tx = new Transaction().add(...withCu(200_000)).add(ix);
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
      console.log("  ClosePortfolio sig:", sig);
    } catch (e: any) {
      console.log("  ClosePortfolio FAILED:", (e.message || "").slice(0, 200));
    }
  }
  await snap("final", market.publicKey, vaultAta);

  console.log("\n=== SUMMARY ===");
  console.log("market:   ", market.publicKey.toBase58());
  console.log("portfolio:", portfolio.publicKey.toBase58());
  console.log("vault ATA:", vaultAta.toBase58());
}

main().catch((e: any) => {
  console.error("FATAL:", e);
  if (e.logs) console.error("LOGS:", e.logs.join("\n"));
  process.exit(1);
});
