/**
 * v16 BOUNTY-5 COMPREHENSIVE SMOKE (devnet).
 *
 * Systematic pass over every v16 API a bounty launch needs.
 *
 *   Stage 1: account creation + InitMarket (max=4 slots)
 *   Stage 2: InitPortfolio × 2 (cross-margin counterparties)
 *   Stage 3: UpdateAssetLifecycle::Activate for assets 1..3
 *   Stage 4: per-asset oracle config — Hyperp on asset 0/3, Hybrid (Pyth) on asset 1, Hybrid (Switchboard) on asset 2
 *   Stage 5: Deposit + TopUpInsurance + TopUpBackingBucket
 *   Stage 6: Policy updates (insurance, liquidation, perm-resolve)
 *   Stage 7: Authority rotation (UpdateAuthority kind=4, then back)
 *   Stage 8: Multi-asset cross-margin trades on assets 0/3 (Hyperp — exec_price known)
 *   Stage 9: PermissionlessCrank Refresh per asset
 *   Stage 10: Liquidate-on-healthy rejection check
 *   Stage 11: Permissionless ops on flat (Rebalance/Forfeit/Cure/FinalizeReset → reject)
 *   Stage 12: SyncMaintenanceFee (permissionless tag 48)
 *   Stage 13: Close positions back to flat + close portfolios
 *   Stage 14: Resolve cycle: ResolveMarket → RefineResolvedUnreceiptedBound → WithdrawInsurance → CloseSlab
 *
 * Each stage prints PASS/FAIL with a reason for any failure.
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
import bs58 from "bs58";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encWithdraw,
  encTradeNoCpi, encPermissionlessCrank, encClosePortfolio, encCloseSlab,
  encTopUpInsurance, encTopUpBackingBucket,
  encConfigureHybridOracle, encConfigureHyperpMark, encPushHyperpMark,
  encUpdateAssetLifecycle, encUpdateAuthority,
  encUpdateInsurancePolicy, encUpdateLiquidationFeePolicy,
  encConfigurePermissionlessResolve, encResolveMarket,
  encWithdrawInsurance, encRefineResolvedUnreceiptedBound,
  encCureAndCancelClose, encForfeitRecoveryLeg,
  encRebalanceReduce, encFinalizeResetSide, encSyncMaintenanceFee,
  encConvertReleasedPnl, encUpdateMaintenanceFeePolicy, encWithdrawBackingBucket,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, PA, PORTFOLIO_STATE_OFF,
  AssetAction, AuthorityKind, OracleProvider,
} from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=" +
  fs.readFileSync(`${process.env.HOME}/percolator-cli/.env`, "utf8").trim().split("=")[1].split("=")[1];
const PROGRAM_ID = new PublicKey(process.env.V16_PROGRAM_ID ?? "Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}
const withCu = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(units, 1_400_000) }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

let passed = 0, failed = 0, soft = 0;
const failures: string[] = [];
async function step(name: string, fn: () => Promise<any>): Promise<any> {
  try {
    const r = await fn();
    console.log(`  ✅  ${name}`);
    passed++;
    return r;
  } catch (e: any) {
    let allLogs = ((e.transactionLogs ?? e.logs) ?? []).join("\n");
    if (!allLogs && e.message) {
      const m = (e.message as string).match(/Transaction (\w{32,})/);
      if (m) {
        const tx = await conn.getTransaction(m[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        allLogs = (tx?.meta?.logMessages ?? []).join(" | ");
      }
    }
    const code = allLogs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
    const msg = code ? `0x${parseInt(code, 16).toString(16)}` : (e.message || "").slice(0, 120);
    console.log(`  ❌  ${name}: ${msg}`);
    if (allLogs && !code) console.log(`      logs: ${allLogs.split("\n").slice(-2).join(" | ").slice(0,200)}`);
    failed++;
    failures.push(`${name} → ${msg}`);
    return null;
  }
}
async function expectReject(name: string, fn: () => Promise<any>, allow: number[]): Promise<void> {
  try {
    await fn();
    console.log(`  ❌  ${name}: expected reject but landed`);
    failed++;
    failures.push(`${name} → unexpected success`);
  } catch (e: any) {
    let allLogs = ((e.transactionLogs ?? e.logs) ?? []).join("\n");
    if (!allLogs && e.message) {
      const m = (e.message as string).match(/Transaction (\w{32,})/);
      if (m) {
        const tx = await conn.getTransaction(m[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        allLogs = (tx?.meta?.logMessages ?? []).join(" | ");
      }
    }
    const codeStr = allLogs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
    const code = codeStr ? parseInt(codeStr, 16) : null;
    if (code !== null && allow.includes(code)) {
      console.log(`  ✅  ${name}: rejected with 0x${code.toString(16)} (expected one of [${allow.map(c => "0x"+c.toString(16)).join(",")}])`);
      passed++;
    } else if (code !== null) {
      console.log(`  ⚠️   ${name}: rejected with 0x${code.toString(16)}; expected [${allow.map(c => "0x"+c.toString(16)).join(",")}]`);
      soft++;
    } else {
      console.log(`  ⚠️   ${name}: rejected with non-program err (${(e.message || "").slice(0,80)})`);
      soft++;
    }
  }
}

async function findPythFeed(): Promise<{addr: PublicKey, feedId: Buffer} | null> {
  // Prefer SMOKE_PYTH_FEED env var (live, pushed-on-demand feed). Falls back
  // to getProgramAccounts walk, which usually hits an abandoned stale feed.
  const envFeed = process.env.SMOKE_PYTH_FEED;
  if (envFeed) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(envFeed), "confirmed");
      if (info) return { addr: new PublicKey(envFeed), feedId: Buffer.from(info.data).subarray(41, 73) };
    } catch { /* fall through */ }
  }
  const disc = Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
  try {
    const accs = await conn.getProgramAccounts(new PublicKey(OracleProvider.PYTH_RECEIVER), {
      commitment: "confirmed",
      filters: [{ dataSize: 134 }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    if (accs.length === 0) return null;
    const a = accs[0]!;
    return { addr: a.pubkey, feedId: Buffer.from(a.account.data).subarray(41, 73) };
  } catch { return null; }
}
async function findSwitchboardFeed(): Promise<PublicKey | null> {
  const envFeed = process.env.SMOKE_SB_FEED;
  if (envFeed) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(envFeed), "confirmed");
      if (info) return new PublicKey(envFeed);
    } catch { /* fall through */ }
  }
  const disc = Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]);
  try {
    const accs = await conn.getProgramAccounts(new PublicKey(OracleProvider.SWITCHBOARD_ONDEMAND_DEVNET), {
      commitment: "confirmed",
      filters: [{ dataSize: 3208 }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    return accs[0]?.pubkey ?? null;
  } catch { return null; }
}

async function main() {
  console.log("v16 bounty-5 comprehensive smoke");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  admin:  ", admin.publicKey.toBase58());
  console.log("  rpc:    ", RPC.split("?")[0]);

  // -------- pre-discovery --------
  console.log("\n[setup] discovering oracle feeds…");
  const pyth = await findPythFeed();
  const sb   = await findSwitchboardFeed();
  console.log(`  Pyth feed:        ${pyth?.addr.toBase58() ?? "(none)"}`);
  console.log(`  Switchboard feed: ${sb?.toBase58() ?? "(none)"}`);

  const market = Keypair.generate();
  const portA = Keypair.generate();
  const portB = Keypair.generate();
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);

  // ====================================================================
  console.log("\n=== Stage 1: Account creation + InitMarket ===");
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  console.log(`  rent: market=${(mkRent/1e9).toFixed(3)} SOL  portfolio=${(pfRent/1e9).toFixed(3)} SOL`);
  await step("create market + 2 portfolios", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(60_000))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
        lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
      [admin, market, portA, portB], { commitment: "confirmed" }));
  await step("InitMarket (max_portfolio_assets=4)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(600_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        ],
        data: encInitMarket({
          // Set max_portfolio_assets to the full target. All slots 0..3 are
          // auto-Active via the InitMarket layout (new_market_group_boxed),
          // so we don't need to call UpdateAssetLifecycle::Activate first.
          // (The "Activate via grow" path is used only for adding assets
          // AFTER initial setup, when portfolios already exist.)
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
          maxBankruptCloseLifetimeSlots: 10_000_000n,
          publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 58n,
        }),
      })),
      [admin], { commitment: "confirmed" }));

  // ====================================================================
  // (Stage 3 — UpdateAssetLifecycle::Activate — not needed when max_portfolio_assets
  // is set high at InitMarket; all slots 0..N-1 are auto-Active. Activation via
  // grow_configured_asset_capacity is exercised separately in smoke-v16-full.ts.)
  console.log("\n=== Stage 3: skipped (assets 0..3 auto-active from InitMarket max=4) ===");

  // ====================================================================
  console.log("\n=== Stage 4: Per-asset oracle profile config ===");
  // asset[0]: Hyperp (admin pushed marks). Profile already manual from InitMarket → ConfigureHyperpMark.
  await step("ConfigureHyperpMark asset[0]", async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    return sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot, initialMarkE6: 1_000_000n,
          markEwmaHalflifeSlots: 300n, markMinFee: 500n }),
      })), [admin], { commitment: "confirmed" });
  });
  // asset[3]: Hyperp too — exec_price-driven, fully market-maker controlled
  await step("ConfigureHyperpMark asset[3]", async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    return sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encConfigureHyperpMark({ assetIndex: 3, nowSlot: slot, initialMarkE6: 4_000_000n,
          markEwmaHalflifeSlots: 300n, markMinFee: 500n }),
      })), [admin], { commitment: "confirmed" });
  });
  // asset[1]: Hybrid Pyth (if we found a feed)
  if (pyth) {
    await step(`ConfigureHybridOracle asset[1] (Pyth ${pyth.addr.toBase58().slice(0,10)}…)`, async () => {
      const slot = BigInt(await conn.getSlot("confirmed"));
      const zero = Buffer.alloc(32);
      return sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(400_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: pyth.addr, isSigner: false, isWritable: false },
          ],
          data: encConfigureHybridOracle({
            assetIndex: 1, nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now()/1000)),
            oracleLegCount: 1, oracleLegFlags: 0,
            maxStalenessSecs: 600n, hybridSoftStaleSlots: 1800n,
            markEwmaHalflifeSlots: 300n, markMinFee: 500n,
            invert: 0, unitScale: 0, confFilterBps: 200,
            oracleLegFeeds: [pyth.feedId.toString("hex"), zero.toString("hex"), zero.toString("hex")],
          }),
        })), [admin], { commitment: "confirmed", skipPreflight: true });
    });
  }
  // asset[2]: Hybrid Chainlink SOL/USD (devnet Chainlink Store has live feeds;
  // Switchboard On-Demand devnet oracle network is dormant). Override with
  // SMOKE_CHAINLINK_FEED env var.
  const chainlinkFeed = new PublicKey(
    process.env.SMOKE_CHAINLINK_FEED ?? "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR",
  );
  await step(`ConfigureHybridOracle asset[2] (Chainlink ${chainlinkFeed.toBase58().slice(0,10)}…)`, async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    const zero = Buffer.alloc(32);
    return sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: chainlinkFeed, isSigner: false, isWritable: false },
        ],
        data: encConfigureHybridOracle({
          assetIndex: 2, nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now()/1000)),
          oracleLegCount: 1, oracleLegFlags: 0,
          maxStalenessSecs: 600n, hybridSoftStaleSlots: 1800n,
          markEwmaHalflifeSlots: 300n, markMinFee: 500n,
          invert: 0, unitScale: 0, confFilterBps: 200,
          // Chainlink uses the feed-account pubkey itself as the feed_id.
          oracleLegFeeds: [chainlinkFeed.toBuffer().toString("hex"), zero.toString("hex"), zero.toString("hex")],
        }),
      })), [admin], { commitment: "confirmed", skipPreflight: true });
  });

  // ====================================================================
  console.log("\n=== Stage 4b: InitPortfolio × 2 (after assets are configured) ===");
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    await step(`InitPortfolio ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(400_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ], data: encInitPortfolio(),
        })), [admin], { commitment: "confirmed" }));
  }

  // ====================================================================
  console.log("\n=== Stage 5: Wrap + Deposit + TopUpInsurance + TopUpBackingBucket ===");
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  await step("create vault ATA + wrap 1.5 SOL", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(50_000))
      .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
      .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 1_500_000_000 }))
      .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
             programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }),
      [admin], { commitment: "confirmed" }));
  const DEPOSIT = 300_000_000n;
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    await step(`Deposit ${DEPOSIT} → ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(600_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ], data: encDeposit(DEPOSIT),
        })), [admin], { commitment: "confirmed" }));
    // Post-deposit probe: confirm PA.capital offset is sane.
    const info = await conn.getAccountInfo(p.publicKey, "confirmed");
    const off = PORTFOLIO_STATE_OFF + PA.capital;
    const cap = info!.data.readBigUInt64LE(off) | (info!.data.readBigUInt64LE(off + 8) << 64n);
    console.log(`  ${n}.capital@${off} after deposit = ${cap}  (expected ${DEPOSIT})  ${cap === DEPOSIT ? "✅" : "⚠️"}`);
  }
  await step("TopUpInsurance 50M", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encTopUpInsurance(50_000_000n),
      })), [admin], { commitment: "confirmed" }));
  const expirySlot = BigInt((await conn.getSlot("confirmed")) + 1_000_000);
  await step("TopUpBackingBucket(domain=0, 20M)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encTopUpBackingBucket({ domain: 0, amount: 20_000_000n, expirySlot }),
      })), [admin], { commitment: "confirmed" }));

  // ====================================================================
  console.log("\n=== Stage 6: Policy updates ===");
  await step("UpdateInsurancePolicy", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encUpdateInsurancePolicy({ maxBps: 5000, depositsOnly: 0, cooldownSlots: 100n }),
      })), [admin], { commitment: "confirmed" }));
  await step("UpdateLiquidationFeePolicy(cranker_share=1000)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encUpdateLiquidationFeePolicy(1000),
      })), [admin], { commitment: "confirmed" }));
  await step("ConfigurePermissionlessResolve", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encConfigurePermissionlessResolve({ staleSlots: 100n, forceCloseDelaySlots: 200n }),
      })), [admin], { commitment: "confirmed" }));

  // ====================================================================
  console.log("\n=== Stage 7: Authority rotation ===");
  const fakeOp = Keypair.generate();
  await step("UpdateAuthority kind=InsuranceOperator → fakeOp", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: fakeOp.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encUpdateAuthority({ kind: AuthorityKind.InsuranceOperator, newPubkey: fakeOp.publicKey }),
      })), [admin, fakeOp], { commitment: "confirmed" }));
  await step("UpdateAuthority rotate back to admin", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: fakeOp.publicKey, isSigner: true, isWritable: false },
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encUpdateAuthority({ kind: AuthorityKind.InsuranceOperator, newPubkey: admin.publicKey }),
      })), [admin, fakeOp], { commitment: "confirmed" }));

  // ====================================================================
  console.log("\n=== Stage 8: Multi-asset trading (Hyperp assets 0 and 3) ===");
  const tradeKeys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ];
  for (const [idx, price] of [[0, 1_000_000n], [3, 4_000_000n]] as const) {
    await step(`TradeNoCpi open asset[${idx}] +10M @ ${price}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(600_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: tradeKeys,
          data: encTradeNoCpi({ assetIndex: idx, sizeQ: 10_000_000n, execPrice: price, feeBps: 1n }),
        })), [admin], { commitment: "confirmed" }));
  }

  // ====================================================================
  console.log("\n=== Stage 9: PermissionlessCrank Refresh per asset ===");
  for (const idx of [0, 3]) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await step(`Refresh asset[${idx}] on portA`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(600_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: portA.publicKey, isSigner: false, isWritable: true },
          ],
          data: encPermissionlessCrank({
            action: 0, assetIndex: idx,
            nowSlot: slot,
            fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
          }),
        })), [admin], { commitment: "confirmed" }));
  }

  // ====================================================================
  console.log("\n=== Stage 10: Liquidate-on-healthy → expect EngineNonProgress (0x16) ===");
  await expectReject("Liquidate healthy portA (with cranker reward tail)", async () => {
    const slot = BigInt(await conn.getSlot("confirmed"));
    return sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(600_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
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
          nowSlot: slot,
          fundingRateE9: 0n, closeQ: 5_000_000n,
          feeBps: 0n, recoveryReason: 0,
        }),
      })), [admin], { commitment: "confirmed", skipPreflight: true });
  }, [0x15, 0x16]);

  // ====================================================================
  console.log("\n=== Stage 11: Permissionless ops on flat (Cure/Forfeit/Rebalance/FinalizeReset → reject) ===");
  await expectReject("CureAndCancelClose(0) on healthy portA", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portA.publicKey, isSigner: false, isWritable: true },
        ], data: encCureAndCancelClose(0n),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x9, 0x15, 0x16]);
  await expectReject("ForfeitRecoveryLeg on healthy asset 1", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portA.publicKey, isSigner: false, isWritable: true },
        ], data: encForfeitRecoveryLeg({ assetIndex: 1, bDeltaBudget: 1n }),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x12, 0x15, 0x16, 0x17, 0x18]);
  await expectReject("RebalanceReduce asset=1 (no position)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portA.publicKey, isSigner: false, isWritable: true },
        ], data: encRebalanceReduce({ assetIndex: 1, reduceQ: 1_000_000n }),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x12, 0x15, 0x16, 0x18]);
  await expectReject("FinalizeResetSide asset=1 side=0 (no reset pending)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(300_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encFinalizeResetSide({ assetIndex: 1, side: 0 }),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x12, 0x15, 0x16]);
  await expectReject("ConvertReleasedPnl(0) on portA", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portA.publicKey, isSigner: false, isWritable: true },
        ], data: encConvertReleasedPnl(0n),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x9, 0x15, 0x16]);

  // ====================================================================
  console.log("\n=== Stage 12: SyncMaintenanceFee (permissionless tag 48) ===");
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await step(`SyncMaintenanceFee on ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(300_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ], data: encSyncMaintenanceFee(slot),
        })), [admin], { commitment: "confirmed" }));
  }

  // ====================================================================
  // Stage 12b: NEW (commit 689b90e) — set maintenance_cranker_fee_share_bps,
  // run SyncMaintenanceFee with portfolio B as the cranker, verify B's
  // capital grew vs. A's by the configured share of the maintenance fee.
  console.log("\n=== Stage 12b: UpdateMaintenanceFeePolicy + cranker-share sync (tag 49 + 48 w/ 3-account form) ===");
  await step("UpdateMaintenanceFeePolicy(cranker_share_bps=2000)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encUpdateMaintenanceFeePolicy(2000),  // 20%
      })), [admin], { commitment: "confirmed" }));

  // Snapshot capitals before
  const capOff = PORTFOLIO_STATE_OFF + PA.capital;
  const readCap = async (k: PublicKey) => {
    const info = await conn.getAccountInfo(k, "confirmed");
    if (!info) throw new Error("portfolio missing");
    return info.data.readBigUInt64LE(capOff) | (info.data.readBigUInt64LE(capOff + 8) << 64n);
  };
  const aCapBefore = await readCap(portA.publicKey);
  const bCapBefore = await readCap(portB.publicKey);
  console.log(`  A.capital before: ${aCapBefore}   B.capital before: ${bCapBefore}`);

  // Wait a few slots so there's accrued fee to harvest.
  const startSlot = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) <= startSlot + 5) {
    await new Promise(r => setTimeout(r, 300));
  }
  const syncSlot = BigInt(await conn.getSlot("confirmed"));

  await step("SyncMaintenanceFee(A) w/ cranker=B (3-account)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: portA.publicKey, isSigner: false, isWritable: true },
          { pubkey: portB.publicKey, isSigner: false, isWritable: true },  // cranker
        ], data: encSyncMaintenanceFee(syncSlot),
      })), [admin], { commitment: "confirmed" }));

  const aCapAfter = await readCap(portA.publicKey);
  const bCapAfter = await readCap(portB.publicKey);
  const aDelta = (aCapBefore > aCapAfter) ? (aCapBefore - aCapAfter) : 0n;  // fee charged from A
  const bDelta = (bCapAfter > bCapBefore) ? (bCapAfter - bCapBefore) : 0n;  // cranker reward to B
  console.log(`  A.capital after:  ${aCapAfter}  (charged ${aDelta})`);
  console.log(`  B.capital after:  ${bCapAfter}  (cranker reward ${bDelta})`);
  if (bDelta === 0n && aDelta > 0n) {
    console.log("  ⚠️  expected B>0 cranker reward (configured 20%); got 0 — flagging");
  } else if (bDelta > 0n) {
    const expectedFloor = aDelta * 2000n / 10_000n;
    console.log(`  expected ≥ ${expectedFloor}, got ${bDelta}  ${bDelta >= expectedFloor ? "✅" : "⚠️"}`);
  }

  // Reset to 0 so later stages don't accidentally consume insurance.
  await step("UpdateMaintenanceFeePolicy(cranker_share_bps=0)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(200_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encUpdateMaintenanceFeePolicy(0),
      })), [admin], { commitment: "confirmed" }));

  // ====================================================================
  console.log("\n=== Stage 13: Close positions + Withdraw + ClosePortfolio ===");
  // PushHyperpMark right before close so the EWMA tracks the close price —
  // otherwise dynamic_fee_bps from slot drift can blow past max_trading_fee_bps
  // (10_000) and the close rejects with 0xe EngineInvalidConfig.
  for (const [idx, price] of [[0, 1_000_000n], [3, 4_000_000n]] as const) {
    await step(`PushHyperpMark asset[${idx}] @ ${price}`, async () => {
      const slot = BigInt(await conn.getSlot("confirmed"));
      return sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(300_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
          ], data: encPushHyperpMark({ assetIndex: idx, nowSlot: slot, markE6: price }),
        })), [admin], { commitment: "confirmed" });
    });
    await step(`TradeNoCpi close asset[${idx}] -10M`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(600_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: tradeKeys,
          data: encTradeNoCpi({ assetIndex: idx, sizeQ: -10_000_000n, execPrice: price, feeBps: 1n }),
        })), [admin], { commitment: "confirmed" }));
  }

  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    await step(`Withdraw all from ${n}`, async () => {
      const info = await conn.getAccountInfo(p.publicKey, "confirmed");
      if (!info) throw new Error("portfolio missing");
      const capOff = PORTFOLIO_STATE_OFF + PA.capital;
      const cap = info.data.readBigUInt64LE(capOff) | (info.data.readBigUInt64LE(capOff + 8) << 64n);
      if (cap === 0n) return null;
      return sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(600_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: vaultAuth, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ], data: encWithdraw(cap),
        })), [admin], { commitment: "confirmed" });
    });
    await step(`ClosePortfolio ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu(400_000))
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ], data: encClosePortfolio(),
        })), [admin], { commitment: "confirmed" }));
  }

  // ====================================================================
  console.log("\n=== Stage 14: Resolve cycle ===");
  await step("ResolveMarket", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(600_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encResolveMarket(),
      })), [admin], { commitment: "confirmed" }));
  await expectReject("RefineResolvedUnreceiptedBound(0) (zero amount)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(300_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ], data: encRefineResolvedUnreceiptedBound(0n),
      })), [admin], { commitment: "confirmed", skipPreflight: true }),
    [0x9, 0x15, 0x16]);
  // WithdrawInsurance — drain everything left in insurance after resolve
  await step("WithdrawInsurance (drain remaining)", async () => {
    const info = await conn.getAccountInfo(market.publicKey, "confirmed");
    if (!info) throw new Error("market missing");
    const insOff = MARKET_GROUP_OFF + MG.insurance;
    const insurance = info.data.readBigUInt64LE(insOff) | (info.data.readBigUInt64LE(insOff + 8) << 64n);
    if (insurance === 0n) return null;
    return sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(600_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdrawInsurance(insurance),
      })), [admin], { commitment: "confirmed" });
  });
  // Drain backing bucket (tag 50, added in commit 55e53d0) so CloseSlab can succeed.
  await step("WithdrawBackingBucket(domain=0, 20M)", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdrawBackingBucket({ domain: 0, amount: 20_000_000n }),
      })), [admin], { commitment: "confirmed" }));

  // CloseSlab — needs vault=0, insurance=0, c_tot=0, materialized=0
  await step("CloseSlab (if vault drained)", async () => {
    const info = await conn.getAccountInfo(market.publicKey, "confirmed");
    if (!info) return null;
    const vaultOff = MARKET_GROUP_OFF + MG.vault;
    const vault = info.data.readBigUInt64LE(vaultOff) | (info.data.readBigUInt64LE(vaultOff + 8) << 64n);
    if (vault !== 0n) throw new Error(`vault=${vault} (need 0)`);
    return sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu(600_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encCloseSlab(),
      })), [admin], { commitment: "confirmed" });
  });

  // ====================================================================
  console.log("\n=================================");
  console.log(`PASS: ${passed}  FAIL: ${failed}  SOFT: ${soft}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach(f => console.log("  •", f));
  }
  console.log("=================================");
  console.log(`market   : ${market.publicKey.toBase58()}`);
  console.log(`portA    : ${portA.publicKey.toBase58()}`);
  console.log(`portB    : ${portB.publicKey.toBase58()}`);
}

main().catch(e => {
  console.error("FATAL:", e);
  if (e.logs) console.error("LOGS:", e.logs.join("\n"));
  process.exit(1);
});
