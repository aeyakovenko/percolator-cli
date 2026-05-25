/**
 * v16 trade/crank/liquidate smoke (devnet).
 *
 * Flow:
 *   1. InitMarket
 *   2. Init 2 portfolios (A long-taker, B short-taker)
 *   3. Deposit collateral into both
 *   4. TradeNoCpi: A buys from B, size=+S, exec=initial_price
 *   5. PermissionlessCrank Refresh on both portfolios
 *   6. TradeNoCpi: A closes back to flat (size=-S)
 *   7. PermissionlessCrank Refresh on both
 *   8. ClosePortfolio for both, then close market vault
 *
 * Goal: verify TradeNoCpi and PermissionlessCrank end-to-end.
 * Liquidation requires moving the price (oracle push) to put a portfolio
 * underwater — separate smoke (smoke-v16-liquidate.ts).
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
  encInitMarket, encInitPortfolio, encDeposit, encWithdraw, encTradeNoCpi,
  encPermissionlessCrank, encClosePortfolio, encCloseSlab,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  parsePortfolio, parseMarketGroup, parseWrapperConfig,
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

async function snapMarket(market: PublicKey, label: string) {
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) { console.log(`[${label}] market not found`); return; }
  const buf = Buffer.from(info.data);
  const g = parseMarketGroup(buf);
  const c = parseWrapperConfig(buf);
  const a = g.assets[0];
  console.log(`[${label}] mode=${g.mode} vault=${g.vault} c_tot=${g.cTot} insurance=${g.insurance} mark_ewma=${c.markEwmaE6} ` +
              `oi_L/S=${a?.oiEffLongQ ?? 0n}/${a?.oiEffShortQ ?? 0n} ` +
              `pos_L/S=${a?.storedPosCountLong ?? 0n}/${a?.storedPosCountShort ?? 0n}`);
}

async function snapPortfolio(p: PublicKey, name: string) {
  const info = await conn.getAccountInfo(p, "confirmed");
  if (!info) { console.log(`  [${name}] not found`); return; }
  const port = parsePortfolio(Buffer.from(info.data));
  console.log(`  [${name}] cap=${port.capital} pnl=${port.pnl} feeCredits=${port.feeCredits} ` +
              `bitmap=0x${port.activeBitmap.toString(16)} legs=${port.legs.length}` +
              (port.legs[0] ? ` leg0={side=${port.legs[0].side}, basis=${port.legs[0].basisPosQ}}` : ""));
}

async function main() {
  console.log("v16 trade smoke");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  rpc:    ", RPC);
  console.log("  admin:  ", admin.publicKey.toBase58());

  const market = Keypair.generate();
  const portfolioA = Keypair.generate();
  const portfolioB = Keypair.generate();
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  console.log("  market:   ", market.publicKey.toBase58());
  console.log("  portA:    ", portfolioA.publicKey.toBase58());
  console.log("  portB:    ", portfolioB.publicKey.toBase58());

  // --- [1] Create market + portfolio accounts in one tx each ---
  console.log("\n[1] Create market + portfolio accounts");
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(50_000))
    .add(SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: portfolioA.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: portfolioB.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
    [admin, market, portfolioA, portfolioB], { commitment: "confirmed" });

  // --- [2] InitMarket ---
  console.log("\n[2] InitMarket");
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(400_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      ],
      data: encInitMarket({
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
  await snapMarket(market.publicKey, "post-InitMarket");

  // --- [3] InitPortfolio × 2 ---
  console.log("\n[3] InitPortfolio A + B");
  for (const p of [portfolioA, portfolioB]) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
        ],
        data: encInitPortfolio(),
      })),
      [admin], { commitment: "confirmed" });
  }

  // --- [4] Wrap SOL + create vault ATA + deposit into both portfolios ---
  console.log("\n[4] Wrap SOL + Deposit");
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...withCu(50_000))
    .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
    .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 500_000_000 }))
    .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
           programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }),
    [admin], { commitment: "confirmed" });

  const DEPOSIT = 200_000_000n;
  for (const p of [portfolioA, portfolioB]) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: encDeposit(DEPOSIT),
      })),
      [admin], { commitment: "confirmed" });
  }
  console.log(`  deposited ${DEPOSIT} into each portfolio`);
  await snapMarket(market.publicKey, "post-Deposit");
  await snapPortfolio(portfolioA.publicKey, "A");
  await snapPortfolio(portfolioB.publicKey, "B");

  // --- [5] TradeNoCpi: A buys from B, size=+50M @ exec=1_000_000 (initial price) ---
  const TRADE_SIZE = 50_000_000n;
  console.log(`\n[5] TradeNoCpi: A buys ${TRADE_SIZE} @ 1_000_000`);
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          // signer_a, signer_b (same admin acts as both)
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portfolioA.publicKey, isSigner: false, isWritable: true },
          { pubkey: portfolioB.publicKey, isSigner: false, isWritable: true },
        ],
        data: encTradeNoCpi({
          assetIndex: 0, sizeQ: TRADE_SIZE, execPrice: 1_000_000n, feeBps: 1n,
        }),
      })),
      [admin], { commitment: "confirmed" });
    console.log("  sig:", sig);
  } catch (e: any) {
    console.log("  FAILED:", (e.message || "").slice(0, 300));
    if (e.logs) console.log("  logs:", e.logs.slice(-10).join("\n  "));
    throw e;
  }
  await snapMarket(market.publicKey, "post-trade-open");
  await snapPortfolio(portfolioA.publicKey, "A");
  await snapPortfolio(portfolioB.publicKey, "B");

  // --- [6] PermissionlessCrank Refresh (action=0) on portfolio A ---
  const slotNow = BigInt(await conn.getSlot("confirmed"));
  console.log(`\n[6] PermissionlessCrank Refresh on A @ now_slot=${slotNow}`);
  try {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portfolioA.publicKey, isSigner: false, isWritable: true },
        ],
        data: encPermissionlessCrank({
          action: 0, assetIndex: 0,
          nowSlot: slotNow,
          effectivePrice: 1_000_000n,
          fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
        }),
      })),
      [admin], { commitment: "confirmed" });
    console.log("  refresh A: ok");
  } catch (e: any) {
    console.log("  refresh A FAILED:", (e.message || "").slice(0, 300));
    if (e.logs) console.log("  logs:", e.logs.slice(-10).join("\n  "));
  }

  // --- [7] TradeNoCpi: close (size = -TRADE_SIZE) ---
  console.log(`\n[7] TradeNoCpi: A sells back ${TRADE_SIZE} @ 1_000_000`);
  try {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portfolioA.publicKey, isSigner: false, isWritable: true },
          { pubkey: portfolioB.publicKey, isSigner: false, isWritable: true },
        ],
        data: encTradeNoCpi({
          assetIndex: 0, sizeQ: -TRADE_SIZE, execPrice: 1_000_000n, feeBps: 1n,
        }),
      })),
      [admin], { commitment: "confirmed" });
    console.log("  close: ok");
  } catch (e: any) {
    console.log("  close FAILED:", (e.message || "").slice(0, 300));
    if (e.logs) console.log("  logs:", e.logs.slice(-10).join("\n  "));
  }
  await snapMarket(market.publicKey, "post-trade-close");
  await snapPortfolio(portfolioA.publicKey, "A");
  await snapPortfolio(portfolioB.publicKey, "B");

  // --- [8] Liquidation attempt (PermissionlessCrank action=1) ---
  // Healthy portfolio → expect rejection or no-op; this exercises the ix shape.
  console.log("\n[8] PermissionlessCrank Liquidate (healthy portfolio → expect rejection)");
  try {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portfolioA.publicKey, isSigner: false, isWritable: true },
        ],
        data: encPermissionlessCrank({
          action: 1, assetIndex: 0,
          nowSlot: slot, effectivePrice: 1_000_000n,
          fundingRateE9: 0n, closeQ: 50_000_000n,
          feeBps: 0n, recoveryReason: 0,
        }),
      })),
      [admin], { commitment: "confirmed" });
    console.log("  liquidate (healthy): ok — engine accepted the action");
  } catch (e: any) {
    const code = (e.transactionLogs ?? []).join("\n").match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
    console.log(`  liquidate (healthy): rejected with ${code ?? (e.message || "").slice(0, 100)} (expected — portfolio is solvent)`);
  }

  // --- [9] Withdraw everything, then ClosePortfolio ---
  console.log("\n[9] Withdraw + ClosePortfolio");
  for (const [name, p] of [["A", portfolioA], ["B", portfolioB]] as const) {
    const info = await conn.getAccountInfo(p.publicKey, "confirmed");
    if (!info) continue;
    const port = parsePortfolio(Buffer.from(info.data));
    if (port.capital > 0n) {
      try {
        await sendAndConfirmTransaction(conn, new Transaction()
          .add(...withCu(400_000))
          .add(new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: admin.publicKey, isSigner: true, isWritable: false },
              { pubkey: market.publicKey, isSigner: false, isWritable: true },
              { pubkey: p.publicKey, isSigner: false, isWritable: true },
              { pubkey: sourceAta, isSigner: false, isWritable: true },
              { pubkey: vaultAta, isSigner: false, isWritable: true },
              { pubkey: vaultAuth, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: encWithdraw(port.capital),
          })),
          [admin], { commitment: "confirmed" });
        console.log(`  withdraw ${name} (${port.capital}): ok`);
      } catch (e: any) {
        console.log(`  withdraw ${name} FAILED: ${(e.message || "").slice(0, 200)}`);
      }
    }
    try {
      await sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(200_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ],
          data: encClosePortfolio(),
        })),
        [admin], { commitment: "confirmed" });
      console.log(`  close ${name}: ok`);
    } catch (e: any) {
      const code = (e.transactionLogs ?? []).join("\n").match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
      console.log(`  close ${name} FAILED: ${code ?? (e.message || "").slice(0, 200)}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  await snapMarket(market.publicKey, "final");
}

main().catch((e: any) => {
  console.error("FATAL:", e);
  if (e.logs) console.error("LOGS:", e.logs.join("\n"));
  process.exit(1);
});
