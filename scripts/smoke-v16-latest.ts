/**
 * Minimal smoke for the latest v16 wrapper (commits 4942e45 → 4096a37).
 *
 * Layout exploded with per-asset oracle profiles + N=64 market slots:
 *   MARKET_ACCOUNT_LEN  : 20,422 → 94,138 B (~0.66 SOL rent)
 *   PORTFOLIO_ACCOUNT_LEN: 7,721 → 22,379 B (~0.156 SOL rent)
 *
 * This smoke proves the new sizes + new wrapper still execute the basic
 * flow: InitMarket → InitPortfolio → Deposit → Withdraw → ClosePortfolio.
 * The complex parsers (MarketGroup field offsets, AssetOracleProfile) are
 * left for a follow-up SDK update.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync, getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encWithdraw, encClosePortfolio,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
} from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.V16_PROGRAM_ID ?? "Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}
const withCu = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

async function main() {
  console.log("v16 latest smoke (post per-asset oracle + N=64 slots)");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  admin:  ", admin.publicKey.toBase58());
  console.log(`  MARKET_ACCOUNT_LEN:    ${MARKET_ACCOUNT_LEN.toLocaleString()} B`);
  console.log(`  PORTFOLIO_ACCOUNT_LEN: ${PORTFOLIO_ACCOUNT_LEN.toLocaleString()} B`);

  const market = Keypair.generate();
  const portfolio = Keypair.generate();
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);

  // [1] Create accounts
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  console.log(`  market rent:    ${(mkRent / 1e9).toFixed(4)} SOL`);
  console.log(`  portfolio rent: ${(pfRent / 1e9).toFixed(4)} SOL`);

  console.log("\n--- [1] Create market + portfolio accounts ---");
  let sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(50_000))
    .add(SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID,
    }))
    .add(SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: portfolio.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID,
    })),
    [admin, market, portfolio], { commitment: "confirmed" });
  console.log("  ✅ create accounts:", sig.slice(0, 20) + "…");

  // [2] InitMarket
  console.log("\n--- [2] InitMarket ---");
  sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(600_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      ],
      data: encInitMarket({
        maxPortfolioAssets: 4,
        hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
        minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
        maintenanceMarginBps: 500n, initialMarginBps: 500n,
        maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
        liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
        minLiquidationAbs: 0n,
        maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n,
        maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
        maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
        publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 58n,
      }),
    })),
    [admin], { commitment: "confirmed" });
  console.log("  ✅ InitMarket:", sig.slice(0, 20) + "…");

  // [3] InitPortfolio
  console.log("\n--- [3] InitPortfolio ---");
  sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(400_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
      ],
      data: encInitPortfolio(),
    })),
    [admin], { commitment: "confirmed" });
  console.log("  ✅ InitPortfolio:", sig.slice(0, 20) + "…");

  // [4] Wrap + Deposit
  console.log("\n--- [4] Wrap SOL + Deposit 100M ---");
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(50_000))
    .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
    .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 200_000_000 }))
    .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
           programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }),
    [admin], { commitment: "confirmed" });
  console.log("  ✅ wrap:", sig.slice(0, 20) + "…");

  sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(600_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encDeposit(100_000_000n),
    })),
    [admin], { commitment: "confirmed" });
  console.log("  ✅ Deposit 100M:", sig.slice(0, 20) + "…");
  const vaultBal1 = (await getAccount(conn, vaultAta, "confirmed")).amount;
  console.log(`  vault SPL after deposit: ${vaultBal1}`);
  if (vaultBal1 !== 100_000_000n) throw new Error(`expected vault=100M, got ${vaultBal1}`);

  // [5] Withdraw all + Close
  console.log("\n--- [5] Withdraw 100M ---");
  sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(600_000))
    .add(new TransactionInstruction({
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
      data: encWithdraw(100_000_000n),
    })),
    [admin], { commitment: "confirmed" });
  const vaultBal2 = (await getAccount(conn, vaultAta, "confirmed")).amount;
  console.log("  ✅ Withdraw:", sig.slice(0, 20) + "…", `vault SPL now ${vaultBal2}`);
  if (vaultBal2 !== 0n) throw new Error(`expected vault=0, got ${vaultBal2}`);

  console.log("\n--- [6] ClosePortfolio ---");
  sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(400_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portfolio.publicKey, isSigner: false, isWritable: true },
      ],
      data: encClosePortfolio(),
    })),
    [admin], { commitment: "confirmed" });
  console.log("  ✅ ClosePortfolio:", sig.slice(0, 20) + "…");

  console.log("\n=== ALL GREEN ===");
  console.log(`market    : ${market.publicKey.toBase58()} (${MARKET_ACCOUNT_LEN.toLocaleString()} B)`);
  console.log(`portfolio : ${portfolio.publicKey.toBase58()} (closed)`);
  console.log(`SPL conservation: deposit 100M → vault 100M → withdraw 100M → vault 0 ✅`);
}

main().catch(e => {
  console.error("FATAL:", e);
  if (e.logs) console.error("LOGS:", e.logs.join("\n"));
  process.exit(1);
});
