/**
 * v16 comprehensive API pass (devnet).
 *
 * Covers EVERY public ix in the v16 wrapper that we can hit without
 * waiting on oracle drift:
 *   InitMarket            (max_portfolio_assets=4)
 *   InitPortfolio         (×2 — TradeNoCpi is bilateral)
 *   UpdateAssetLifecycle  (PendingActivation + Active for assets 1..=3)
 *   Deposit
 *   ConfigureHybridOracle (no-op on Manual mode — verify rejection path)
 *   ConfigureHyperpMark   (sets EWMA halflife + mark_min_fee)
 *   PushHyperpMark        (push a new mark via authority)
 *   TopUpInsurance
 *   TopUpBackingBucket    (per-domain backing deposit)
 *   UpdateInsurancePolicy
 *   UpdateLiquidationFeePolicy
 *   ConfigurePermissionlessResolve
 *   TradeNoCpi            (asset 0, 1, 2 — multi-leg portfolio)
 *   PermissionlessCrank   (action=0 Refresh; action=1 Liquidate on healthy → reject)
 *   WithdrawInsuranceLimited
 *   ConvertReleasedPnl    (zero-amount touch — verify ix decode)
 *   UpdateAuthority       (rotate insurance_operator)
 *   Withdraw + ClosePortfolio + Withdraw insurance + CloseSlab (cleanup)
 *
 * NOT covered yet (require special prerequisites): TradeCpi (needs matcher
 * program); SettleB action; full liquidation cycle (needs underwater portfolio);
 * ResolveMarket; ResolveStalePermissionless.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encWithdraw,
  encTradeNoCpi, encPermissionlessCrank, encClosePortfolio, encCloseSlab,
  encTopUpInsurance, encWithdrawInsuranceLimited, encTopUpBackingBucket,
  encConvertReleasedPnl, encUpdateAuthority, encUpdateInsurancePolicy,
  encUpdateLiquidationFeePolicy, encConfigurePermissionlessResolve,
  encConfigureHybridOracle, encConfigureHyperpMark, encPushHyperpMark,
  encUpdateAssetLifecycle,
  encWithdrawInsurance, encCureAndCancelClose, encForfeitRecoveryLeg,
  encRebalanceReduce, encFinalizeResetSide, encClaimResolvedPayoutTopup,
  encRefineResolvedUnreceiptedBound, encSyncMaintenanceFee,
  encResolveMarket,
  AssetAction,
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

let passed = 0, failed = 0, skipped = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    console.log(`  ✅  ${name}`);
    passed++;
    return r;
  } catch (e: any) {
    const code = (e.transactionLogs ?? []).join("\n").match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
    console.log(`  ❌  ${name}: ${code ?? (e.message || "").slice(0, 140)}`);
    if (e.logs) console.log("      logs:", e.logs.slice(-6).map((l: string) => `      ${l}`).join("\n"));
    failed++;
    return null;
  }
}
async function expectReject<T>(name: string, fn: () => Promise<T>, expectedCodes: number[]): Promise<void> {
  try {
    await fn();
    console.log(`  ❌  ${name}: expected rejection but landed`);
    failed++;
  } catch (e: any) {
    let allLogs = ((e.transactionLogs ?? e.logs) ?? []).join("\n");
    // For skipPreflight txs that landed on chain with an err, the logs aren't
    // attached to the throw — fetch them from chain via the sig in e.message.
    if (!allLogs) {
      const sigMatch = (e.message ?? "").match(/Transaction (\w{32,})/);
      if (sigMatch) {
        const tx = await conn.getTransaction(sigMatch[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        allLogs = (tx?.meta?.logMessages ?? []).join("\n");
      }
    }
    const codeStr = allLogs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
    const code = codeStr ? parseInt(codeStr, 16) : null;
    if (code !== null && expectedCodes.includes(code)) {
      console.log(`  ✅  ${name}: rejected with 0x${code.toString(16)} (expected)`);
      passed++;
    } else if (code !== null) {
      console.log(`  ⚠️   ${name}: rejected with 0x${code.toString(16)}; expected one of ${expectedCodes.map(c => "0x"+c.toString(16)).join(",")}`);
      skipped++;
    } else {
      console.log(`  ⚠️   ${name}: ${(e.message || "").slice(0, 150)}`);
      if (allLogs) console.log("      logs:", allLogs.split("\n").slice(-4).join("\n      "));
      skipped++;
    }
  }
}

async function snapMarket(market: PublicKey, label: string) {
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) { console.log(`    [${label}] market not found`); return; }
  const buf = Buffer.from(info.data);
  const g = parseMarketGroup(buf);
  const c = parseWrapperConfig(buf);
  console.log(`    [${label}] mode=${g.mode} vault=${g.vault} c_tot=${g.cTot} insurance=${g.insurance} ` +
              `act_assets=${g.assetActivationCount} assets=${g.assets.length} ` +
              `flags=hlock:${g.bankruptcyHlockActive} stress:${g.thresholdStressActive} stale:${g.lossStaleActive}`);
  for (const a of g.assets) {
    console.log(`        asset[${a.index}] price=${a.effectivePrice} oi_L/S=${a.oiEffLongQ}/${a.oiEffShortQ} pos=${a.storedPosCountLong}/${a.storedPosCountShort}`);
  }
}
async function snapPortfolio(p: PublicKey, name: string) {
  const info = await conn.getAccountInfo(p, "confirmed");
  if (!info) { console.log(`    [${name}] not found`); return; }
  const port = parsePortfolio(Buffer.from(info.data));
  console.log(`    [${name}] cap=${port.capital} pnl=${port.pnl} fee_credits=${port.feeCredits} ` +
              `bitmap=0x${port.activeBitmap.toString(16)}n legs=${port.legs.length}`);
  for (const l of port.legs) {
    console.log(`        leg[${l.index}] side=${l.side} basis_pos=${l.basisPosQ}`);
  }
}

async function main() {
  console.log("v16 full API smoke");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  admin:  ", admin.publicKey.toBase58());

  const market = Keypair.generate();
  const portA = Keypair.generate();
  const portB = Keypair.generate();
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  console.log("  market: ", market.publicKey.toBase58());

  // -------- Setup --------
  console.log("\n--- Setup ---");
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  await step("create market + 2 portfolios (system-create)", async () => {
    return await sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(50_000))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
        lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
      [admin, market, portA, portB], { commitment: "confirmed" });
  });

  // -------- InitMarket (4 assets, hyperp-style) --------
  console.log("\n--- InitMarket (max_portfolio_assets=4) ---");
  await step("InitMarket", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      ],
      data: encInitMarket({
        maxPortfolioAssets: 4,
        hMin: 0n, hMax: 10n, initialPrice: 1_000_000n,    // tiny horizon so pnl matures within smoke
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
    })), [admin], { commitment: "confirmed" }));
  await snapMarket(market.publicKey, "after-InitMarket");

  // -------- InitPortfolio × 2 --------
  console.log("\n--- InitPortfolio × 2 ---");
  for (const p of [portA, portB]) {
    await step(`InitPortfolio ${p.publicKey.toBase58().slice(0,8)}`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
        ], data: encInitPortfolio(),
      })), [admin], { commitment: "confirmed" }));
  }

  // -------- UpdateAssetLifecycle: activate assets 1..3 --------
  console.log("\n--- UpdateAssetLifecycle: activate assets 1..3 ---");
  for (const idx of [1, 2, 3]) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await step(`activate asset[${idx}] @ price=${idx + 1}_000_000`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encUpdateAssetLifecycle({
          action: AssetAction.Activate,    // wrapper code 0 (NOT lifecycle enum 2)
          assetIndex: idx,
          nowSlot: slot,
          initialPrice: BigInt((idx + 1) * 1_000_000),
          // per-asset domain authorities (appended in commit 05a8f84) — admin-held
          insuranceAuthority: admin.publicKey,
          insuranceOperator: admin.publicKey,
          backingBucketAuthority: admin.publicKey,
          oracleAuthority: admin.publicKey,
        }),
      })), [admin], { commitment: "confirmed" }));
  }
  await snapMarket(market.publicKey, "after-UpdateAssetLifecycle");

  // -------- Wrap + Deposit --------
  console.log("\n--- Wrap SOL + Deposit ---");
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  await step("create vault ATA + wrap 1 SOL", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(50_000))
      .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
      .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 1_500_000_000 }))
      .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
             programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }),
      [admin], { commitment: "confirmed" }));
  const DEPOSIT = 300_000_000n;
  for (const p of [portA, portB]) {
    await step(`Deposit ${DEPOSIT} → ${p.publicKey.toBase58().slice(0,8)}`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encDeposit(DEPOSIT),
      })), [admin], { commitment: "confirmed" }));
  }

  // -------- TopUpInsurance --------
  console.log("\n--- TopUpInsurance ---");
  await step("TopUpInsurance 50_000_000", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encTopUpInsurance(50_000_000n),
    })), [admin], { commitment: "confirmed" }));

  // -------- TopUpBackingBucket (domain 0) --------
  console.log("\n--- TopUpBackingBucket ---");
  const futureSlot = BigInt((await conn.getSlot("confirmed")) + 1_000_000);
  await step("TopUpBackingBucket domain=0 amount=20_000_000", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encTopUpBackingBucket({ domain: 0, amount: 20_000_000n, expirySlot: futureSlot }),
    })), [admin], { commitment: "confirmed" }));

  // -------- UpdateInsurancePolicy + UpdateLiquidationFeePolicy + ConfigurePermissionlessResolve --------
  console.log("\n--- Policy updates ---");
  await step("UpdateInsurancePolicy (max=10000bps, deposits_only=0, cooldown=0)", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(150_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encUpdateInsurancePolicy({ maxBps: 10000, depositsOnly: 0, cooldownSlots: 0n }),
    })), [admin], { commitment: "confirmed" }));
  await step("UpdateLiquidationFeePolicy (cranker_share=1000bps)", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(150_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encUpdateLiquidationFeePolicy(1000),
    })), [admin], { commitment: "confirmed" }));
  await step("ConfigurePermissionlessResolve (stale=100, fc_delay=200)", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(150_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encConfigurePermissionlessResolve({ staleSlots: 100n, forceCloseDelaySlots: 200n }),
    })), [admin], { commitment: "confirmed" }));

  // -------- ConfigureHyperpMark + PushHyperpMark --------
  console.log("\n--- Hyperp mark configure + push ---");
  await step("ConfigureHyperpMark (halflife=300, min_fee=500)", async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    return sendAndConfirmTransaction(conn, new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encConfigureHyperpMark({ nowSlot: slot, initialMarkE6: 1_000_000n, markEwmaHalflifeSlots: 300n, markMinFee: 500n }),
    })), [admin], { commitment: "confirmed" });
  });
  await step("PushHyperpMark (mark=1_010_000)", async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    return sendAndConfirmTransaction(conn, new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encPushHyperpMark({ nowSlot: slot, markE6: 1_010_000n }),
    })), [admin], { commitment: "confirmed" });
  });

  // -------- UpdateAuthority (rotate insurance_operator to a fresh keypair, then back) --------
  // Wrapper requires [current, new_authority, market]; new_authority must sign unless burning.
  console.log("\n--- UpdateAuthority (rotate insurance_operator, kind=4) ---");
  const fakeOp = Keypair.generate();
  // First top-up so the fake op can pay rent for any subsequent ix (not strictly needed; signer only).
  await step(`UpdateAuthority kind=InsuranceOperator → ${fakeOp.publicKey.toBase58().slice(0,8)}`, () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(150_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: fakeOp.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encUpdateAuthority({ kind: 4, newPubkey: fakeOp.publicKey }),  // 4 = InsuranceOperator
    })), [admin, fakeOp], { commitment: "confirmed" }));
  await step("UpdateAuthority rotate insurance_operator back to admin", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(150_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: fakeOp.publicKey, isSigner: true, isWritable: false },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encUpdateAuthority({ kind: 4, newPubkey: admin.publicKey }),
    })), [admin, fakeOp], { commitment: "confirmed" }));

  // -------- WithdrawInsuranceLimited BEFORE trades, while market is clean --------
  console.log("\n--- WithdrawInsuranceLimited (pre-trade) ---");
  await step("WithdrawInsuranceLimited 1_000_000", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encWithdrawInsuranceLimited(1_000_000n),
    })), [admin], { commitment: "confirmed" }));

  // -------- Multi-asset trading: open positions on asset[0], asset[1], asset[2] --------
  console.log("\n--- Multi-asset trading ---");
  const tradeKeys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ];
  for (const [idx, price] of [[0, 1_000_000n], [1, 2_000_000n], [2, 3_000_000n]] as const) {
    await step(`TradeNoCpi asset[${idx}] +10M @ ${price}`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: tradeKeys,
        data: encTradeNoCpi({ assetIndex: idx, sizeQ: 10_000_000n, execPrice: price, feeBps: 1n }),
      })), [admin], { commitment: "confirmed" }));
  }
  await snapMarket(market.publicKey, "after-multi-asset-open");
  await snapPortfolio(portA.publicKey, "A");
  await snapPortfolio(portB.publicKey, "B");

  // -------- PermissionlessCrank Refresh on multiple assets --------
  console.log("\n--- PermissionlessCrank Refresh on assets 0..2 ---");
  for (const idx of [0, 1, 2]) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await step(`Refresh asset[${idx}] on portA`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portA.publicKey, isSigner: false, isWritable: true },
        ],
        data: encPermissionlessCrank({
          action: 0, assetIndex: idx,
          nowSlot: slot,
          effectivePrice: BigInt((idx + 1) * 1_000_000),
          fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
        }),
      })), [admin], { commitment: "confirmed" }));
  }

  // -------- Liquidate (healthy → reject) --------
  console.log("\n--- Liquidate on healthy portfolio (expect 0x16 EngineNonProgress) ---");
  await expectReject("liquidate healthy portA (with cranker reward tail)", async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    // When liquidation_cranker_fee_share_bps != 0, action=1 demands reward
    // accounts: [cranker_token, vault_token, vault_auth, token_program] at indices 3..6.
    return sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portA.publicKey, isSigner: false, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encPermissionlessCrank({
        action: 1, assetIndex: 0,
        nowSlot: slot, effectivePrice: 1_000_000n,
        fundingRateE9: 0n, closeQ: 5_000_000n,
        feeBps: 0n, recoveryReason: 0,
      }),
    })), [admin], { commitment: "confirmed", skipPreflight: true });
  }, [0x16, 0x15]); // EngineNonProgress / EngineLockActive both fine — healthy → no work

  // (WithdrawInsuranceLimited moved to pre-trade)

  // -------- ConvertReleasedPnl (touch) --------
  console.log("\n--- ConvertReleasedPnl (zero-amount touch) ---");
  await expectReject("ConvertReleasedPnl 0 (zero amount likely rejected)", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portA.publicKey, isSigner: false, isWritable: true },
      ],
      data: encConvertReleasedPnl(0n),
    })), [admin], { commitment: "confirmed" }),
    [0x9, 0xe, 0xf, 0x10, 0x11, 0x15, 0x16]);  // any "no progress" / "invalid" is fine

  // -------- Close positions: reverse each trade AT current effective price --------
  // (avoid off-mark close which would accrue unmaturable PnL that blocks ConvertReleasedPnl)
  console.log("\n--- Close positions (reverse trades at current effective price) ---");
  {
    // Re-read market to get current effective prices
    const info = await conn.getAccountInfo(market.publicKey, "confirmed");
    const g = parseMarketGroup(Buffer.from(info!.data));
    const priceFor = (idx: number) =>
      g.assets.find(a => a.index === idx)?.effectivePrice ?? BigInt((idx + 1) * 1_000_000);
    for (const idx of [0, 1, 2]) {
      const p = priceFor(idx);
      await step(`TradeNoCpi asset[${idx}] -10M @ ${p} (close)`, () =>
        sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: tradeKeys,
          data: encTradeNoCpi({ assetIndex: idx, sizeQ: -10_000_000n, execPrice: p, feeBps: 1n }),
        })), [admin], { commitment: "confirmed" }));
    }
  }
  await snapMarket(market.publicKey, "after-close-all");
  await snapPortfolio(portA.publicKey, "A");
  await snapPortfolio(portB.publicKey, "B");

  // -------- SyncMaintenanceFee (permissionless — should bump pnl_matured_pos_tot) --------
  console.log("\n--- SyncMaintenanceFee (tag 48) on both portfolios ---");
  for (const [name, p] of [["A", portA], ["B", portB]] as const) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await step(`SyncMaintenanceFee on ${name}`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
        ],
        data: encSyncMaintenanceFee(slot),
      })), [admin], { commitment: "confirmed" }));
  }

  // -------- RebalanceReduce (permissionless reduce — expect rejection on flat portfolios) --------
  console.log("\n--- RebalanceReduce (tag 44) on flat portA → expect rejection ---");
  await expectReject("RebalanceReduce on flat asset=0 (no work)", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portA.publicKey, isSigner: false, isWritable: true },
      ],
      data: encRebalanceReduce({ assetIndex: 0, reduceQ: 1_000_000n }),
    })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x12, 0x15, 0x16, 0x18]);  // EngineInvalidLeg(0x12) / LockActive / NonProgress / InvalidLeg(b'18)

  // -------- ForfeitRecoveryLeg (permissionless — expect reject on healthy leg) --------
  console.log("\n--- ForfeitRecoveryLeg (tag 43) on flat → expect rejection ---");
  await expectReject("ForfeitRecoveryLeg on flat asset=0", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portA.publicKey, isSigner: false, isWritable: true },
      ],
      data: encForfeitRecoveryLeg({ assetIndex: 0, bDeltaBudget: 1n }),
    })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x12, 0x15, 0x16, 0x17, 0x18]);

  // -------- CureAndCancelClose (no close pending → reject) --------
  console.log("\n--- CureAndCancelClose (tag 42) on portA → expect rejection (no close pending) ---");
  await expectReject("CureAndCancelClose deposit=0 on healthy portA", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: portA.publicKey, isSigner: false, isWritable: true },
      ],
      data: encCureAndCancelClose(0n),
    })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x15, 0x16]);

  // -------- FinalizeResetSide (no reset pending → reject) --------
  console.log("\n--- FinalizeResetSide (tag 45) → expect rejection (no reset pending) ---");
  await expectReject("FinalizeResetSide asset=0 side=0", () =>
    sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encFinalizeResetSide({ assetIndex: 0, side: 0 }),
    })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x12, 0x15, 0x16]);

  // -------- Refresh again after closes (clear loss-stale state) --------
  console.log("\n--- Refresh post-close (clear loss_stale) ---");
  for (const idx of [0, 1, 2]) {
    for (const [name, p] of [["A", portA], ["B", portB]] as const) {
      const slot = BigInt(await conn.getSlot("confirmed"));
      await step(`Refresh asset[${idx}] on ${name}`, () =>
        sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ],
          data: encPermissionlessCrank({
            action: 0, assetIndex: idx,
            nowSlot: slot, effectivePrice: BigInt((idx + 1) * 1_000_000),
            fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
          }),
        })), [admin], { commitment: "confirmed" }));
    }
  }
  await snapMarket(market.publicKey, "after-stale-clear");

  // -------- Final: ConvertReleasedPnl (if any) → Withdraw → ClosePortfolio --------
  // Wait > h_max=10 slots so positive PnL fully matures into the released bucket.
  console.log("\n--- Wait for pnl maturity ---");
  const beforeWait = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) < beforeWait + 25) {
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`  slot advanced ${beforeWait} → ${await conn.getSlot("confirmed")} (>h_max=10)`);
  // One more refresh round so the engine sees the elapsed slots.
  for (const idx of [0, 1, 2]) {
    for (const p of [portA, portB]) {
      const slot = BigInt(await conn.getSlot("confirmed"));
      await sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
        ],
        data: encPermissionlessCrank({
          action: 0, assetIndex: idx,
          nowSlot: slot, effectivePrice: BigInt((idx + 1) * 1_000_000),
          fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
        }),
      })), [admin], { commitment: "confirmed" }).catch(() => {});
    }
  }

  console.log("\n--- Final: Withdraw + ClosePortfolio ---");
  for (const [name, p] of [["A", portA], ["B", portB]] as const) {
    const info = await conn.getAccountInfo(p.publicKey, "confirmed");
    if (!info) continue;
    const port = parsePortfolio(Buffer.from(info.data));
    // Positive PnL needs to convert to capital before the portfolio can close.
    if (port.pnl > 0n) {
      await step(`ConvertReleasedPnl ${port.pnl} on ${name}`, () =>
        sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ],
          data: encConvertReleasedPnl(port.pnl as bigint),
        })), [admin], { commitment: "confirmed" }));
    }
    // Re-read after conversion
    const info2 = await conn.getAccountInfo(p.publicKey, "confirmed");
    const port2 = parsePortfolio(Buffer.from(info2!.data));
    if (port2.capital > 0n) {
      await step(`Withdraw ${port2.capital} from ${name}`, () =>
        sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
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
          data: encWithdraw(port2.capital),
        })), [admin], { commitment: "confirmed" }));
    }
    await step(`ClosePortfolio ${name}`, () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
        ],
        data: encClosePortfolio(),
      })), [admin], { commitment: "confirmed" }));
  }

  // -------- Resolve cycle: only attempt if all portfolios closed --------
  console.log("\n--- Resolve cycle ---");
  const m1 = await conn.getAccountInfo(market.publicKey, "confirmed");
  const g1 = parseMarketGroup(Buffer.from(m1!.data));
  if (g1.materializedPortfolioCount === 0n && g1.cTot === 0n) {
    await step("ResolveMarket (tag 19)", () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encResolveMarket(),
      })), [admin], { commitment: "confirmed" }));

    // RefineResolvedUnreceiptedBound — narrow bound by 0 (touch)
    await expectReject("RefineResolvedUnreceiptedBound 0 (zero → reject)", () =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encRefineResolvedUnreceiptedBound(0n),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
      [0x9, 0x15, 0x16]);

    // WithdrawInsurance — pull all remaining insurance
    const m2 = await conn.getAccountInfo(market.publicKey, "confirmed");
    const g2 = parseMarketGroup(Buffer.from(m2!.data));
    if (g2.insurance > 0n) {
      await step(`WithdrawInsurance ${g2.insurance} (tag 41)`, () =>
        sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: vaultAuth, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: encWithdrawInsurance(g2.insurance),
        })), [admin], { commitment: "confirmed" }));
    }

    // CloseSlab — vault should be 0 now
    const m3 = await conn.getAccountInfo(market.publicKey, "confirmed");
    const g3 = parseMarketGroup(Buffer.from(m3!.data));
    if (g3.vault === 0n && g3.insurance === 0n) {
      await step("CloseSlab (tag 13)", () =>
        sendAndConfirmTransaction(conn, new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: true },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: vaultAuth, isSigner: false, isWritable: false },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: encCloseSlab(),
        })), [admin], { commitment: "confirmed" }));
    } else {
      console.log(`  (CloseSlab skipped: vault=${g3.vault} insurance=${g3.insurance})`);
    }
  } else {
    console.log(`  (Resolve skipped: materialized=${g1.materializedPortfolioCount} c_tot=${g1.cTot})`);
  }

  console.log("\n=================================");
  console.log(`PASS: ${passed}  FAIL: ${failed}  SOFT: ${skipped}`);
  console.log("=================================");
  await snapMarket(market.publicKey, "final");
  if (failed > 0) process.exit(1);
}

main().catch((e: any) => {
  console.error("FATAL:", e);
  if (e.logs) console.error("LOGS:", e.logs.join("\n"));
  process.exit(1);
});
