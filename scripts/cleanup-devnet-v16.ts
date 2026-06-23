/**
 * Devnet cleanup: close every v16 market + portfolio owned by the bounty-5
 * program (`Bu1J8eQQN…`) to reclaim rent (~33 SOL).
 *
 * For each market:
 *   - If Live (mode=0): try ResolveMarket
 *   - WithdrawInsurance (if insurance > 0)
 *   - WithdrawBackingBucket (if vault > 0) — try domain 0
 *   - CloseSlab
 *
 * For each portfolio:
 *   - Try Withdraw (if capital > 0)
 *   - ClosePortfolio
 *
 * Failures are logged but don't abort — best-effort sweep.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import bs58 from "bs58";
import {
  encWithdrawInsurance, encCloseSlab, encResolveMarket,
  encWithdraw, encClosePortfolio, encWithdrawBackingBucket,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, PORTFOLIO_STATE_OFF, PA,
  KIND_MARKET, KIND_PORTFOLIO, PROV,
} from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=2dfa2086-c6cd-4cb4-8a13-08ecdee36a0f";
const PROGRAM_ID = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}
const cu = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
function headerBytes(kind: number): Buffer {
  const b = Buffer.alloc(11);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(16, 8);
  b.writeUInt8(kind, 10);
  return b;
}
const rd128 = (d: Buffer, off: number) => d.readBigUInt64LE(off) | (d.readBigUInt64LE(off + 8) << 64n);

async function tryTx(label: string, ixs: TransactionInstruction[]): Promise<boolean> {
  try {
    const tx = new Transaction().add(...cu(600_000)).add(...ixs);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: true });
    console.log(`    ✅ ${label}: ${sig.slice(0,12)}…`);
    return true;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.log(`    ❌ ${label}: ${msg.slice(0, 100)}`);
    return false;
  }
}

async function cleanupMarket(market: PublicKey) {
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) { console.log(`[market] ${market.toBase58()}  (gone)`); return; }
  // Legacy pre-collapse layouts (94K+) are unparseable under current MG offsets — skip.
  if (info.data.length > 50000) {
    console.log(`[market] ${market.toBase58()}  ${info.data.length}B  (legacy layout, skipping)`);
    return;
  }
  console.log(`\n[market] ${market.toBase58()}  ${info.data.length}B`);
  const d = Buffer.from(info.data);
  const mode = d[MARKET_GROUP_OFF + MG.mode];
  const vault = rd128(d, MARKET_GROUP_OFF + MG.vault);
  const insurance = rd128(d, MARKET_GROUP_OFF + MG.insurance);
  const cTot = rd128(d, MARKET_GROUP_OFF + MG.c_tot);
  const used = d.readBigUInt64LE(MARKET_GROUP_OFF + MG.materialized_portfolio_count);
  console.log(`  mode=${mode} vault=${vault} ins=${insurance} cTot=${cTot} ports=${used}`);
  if (used > 0n || cTot > 0n) {
    console.log("  (live with active portfolios — skipping; portfolios must close first)");
    return;
  }
  const [vaultAuth] = deriveVaultAuthority(market);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);

  // Resolve if live.
  if (mode === 0) {
    await tryTx("ResolveMarket", [
      new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
        ], data: encResolveMarket(),
      }),
    ]);
  }
  // Drain insurance.
  if (insurance > 0n) {
    await tryTx("WithdrawInsurance", [
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, sourceAta, admin.publicKey, NATIVE_MINT),
      new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdrawInsurance(insurance),
      }),
    ]);
  }
  // Drain backing bucket. Try domain 0 with current vault as amount.
  const info2 = await conn.getAccountInfo(market, "confirmed");
  if (info2) {
    const v2 = rd128(Buffer.from(info2.data), MARKET_GROUP_OFF + MG.vault);
    if (v2 > 0n) {
      await tryTx(`WithdrawBackingBucket(0,${v2})`, [
        new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: vaultAuth, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ], data: encWithdrawBackingBucket({ domain: 0, amount: v2 }),
        }),
      ]);
    }
  }
  // CloseSlab.
  await tryTx("CloseSlab", [
    new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ], data: encCloseSlab(),
    }),
  ]);
}

async function cleanupPortfolio(p: PublicKey) {
  const info = await conn.getAccountInfo(p, "confirmed");
  if (!info) { console.log(`[portfolio] ${p.toBase58()}  (gone)`); return; }
  if (info.data.length > 50000) {
    console.log(`[portfolio] ${p.toBase58()}  ${info.data.length}B  (legacy layout, skipping)`);
    return;
  }
  console.log(`\n[portfolio] ${p.toBase58()}  ${info.data.length}B`);
  const d = Buffer.from(info.data);
  // provenance_header.market_group_id at offset 0..32 inside portfolio state.
  const marketBytes = d.subarray(PORTFOLIO_STATE_OFF + PROV.market_group_id, PORTFOLIO_STATE_OFF + PROV.market_group_id + 32);
  const market = new PublicKey(marketBytes);
  const cap = rd128(d, PORTFOLIO_STATE_OFF + PA.capital);
  console.log(`  market=${market.toBase58()}  capital=${cap}`);
  const mktInfo = await conn.getAccountInfo(market, "confirmed");
  if (!mktInfo) { console.log("  (parent market gone — portfolio is orphan, ClosePortfolio likely fails)"); }
  const [vaultAuth] = deriveVaultAuthority(market);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  if (cap > 0n && mktInfo) {
    await tryTx(`Withdraw(${cap})`, [
      new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: p, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdraw(cap),
      }),
    ]);
  }
  if (mktInfo) {
    await tryTx("ClosePortfolio", [
      new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: p, isSigner: false, isWritable: true },
        ], data: encClosePortfolio(),
      }),
    ]);
  }
}

async function main() {
  console.log("admin:", admin.publicKey.toBase58());
  const balBefore = (await conn.getBalance(admin.publicKey)) / 1e9;
  console.log(`pre balance: ${balBefore} SOL`);

  console.log("\n=== closing portfolios first (so parent markets become closeable) ===");
  const ports = await conn.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(headerBytes(KIND_PORTFOLIO)) } },
    ],
  });
  console.log(`  found ${ports.length} portfolios`);
  for (const { pubkey } of ports) {
    await cleanupPortfolio(pubkey);
  }

  console.log("\n=== closing markets ===");
  const mkts = await conn.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(headerBytes(KIND_MARKET)) } },
    ],
  });
  console.log(`  found ${mkts.length} markets`);
  for (const { pubkey } of mkts) {
    await cleanupMarket(pubkey);
  }

  // Unwrap any leftover wSOL.
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const ataInfo = await conn.getAccountInfo(sourceAta).catch(() => null);
  if (ataInfo) {
    await tryTx("close wSOL ATA", [createCloseAccountInstruction(sourceAta, admin.publicKey, admin.publicKey)]);
  }

  const balAfter = (await conn.getBalance(admin.publicKey)) / 1e9;
  console.log(`\npost balance: ${balAfter} SOL  (+${(balAfter - balBefore).toFixed(4)} SOL)`);
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });
