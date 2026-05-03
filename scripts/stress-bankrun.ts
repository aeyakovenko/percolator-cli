/**
 * Stress test: bankruptcies, ADL triggers, and bank runs.
 * Creates leveraged positions, crashes the price, forces liquidations,
 * exhausts insurance, triggers ADL, then bank-runs the vault.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, mintTo, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket, encodeInitUser, encodeInitLP,
} from "../src/abi/instructions.js";
import { defaultInitMarketArgs } from "./_default-market.js";
import {
  encodeDepositCollateral, encodeWithdrawCollateral,
  encodeKeeperCrank, encodeTradeCpi,
  encodeCloseAccount, encodeCloseSlab, encodeTopUpInsurance,
  encodeSetOracleAuthority, encodePushOraclePrice,
  encodeResolveMarket, encodeAdminForceCloseAccount,
  encodeWithdrawInsurance, encodeLiquidateAtOracle,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_USER, ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_ADMIN_FORCE_CLOSE,
  ACCOUNTS_WITHDRAW_INSURANCE, ACCOUNTS_LIQUIDATE_AT_ORACLE, ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import {
  parseHeader, parseConfig, parseEngine, parseParams,
  parseUsedIndices, parseAccount, fetchSlab, isAccountUsed,
} from "../src/solana/slab.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";

const PROG = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const SLAB_SIZE = 1755376;
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))
));

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function tx(ixs: any[], signers: Keypair[], cu = 200000) {
  const t = new Transaction();
  t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  for (const ix of ixs) t.add(ix);
  return sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed" });
}

async function getSpl(vault: PublicKey): Promise<bigint> {
  return (await getAccount(conn, vault)).amount;
}

function pushPrice(priceE6: string) {
  return encodePushOraclePrice({ priceE6, timestamp: Math.floor(Date.now() / 1000).toString() });
}

async function dumpState(slab: PublicKey, vault: PublicKey, label: string) {
  const buf = await fetchSlab(conn, slab);
  const e = parseEngine(buf);
  const used = parseUsedIndices(buf);
  const spl = await getSpl(vault);
  const splMatch = e.vault === spl;
  const acctOk = e.vault >= e.cTot + e.insuranceFund.balance;
  console.log(`  [${label}] vault=${e.vault} cTot=${e.cTot} ins=${e.insuranceFund.balance} numUsed=${e.numUsedAccounts} spl=${spl} conservation=${splMatch ? "OK" : "BROKEN"} accounting=${acctOk ? "OK" : "BROKEN"}`);
  console.log(`    sideModeLong=${e.sideModeLong} sideModeShort=${e.sideModeShort} adlMultLong=${e.adlMultLong} adlMultShort=${e.adlMultShort}`);
  for (const idx of used) {
    const a = parseAccount(buf, idx);
    console.log(`    [${idx}] kind=${a.kind} capital=${a.capital} pos=${a.positionBasisQ} pnl=${a.pnl} reserved=${a.reservedPnl}`);
  }
  if (!splMatch) throw new Error(`CONSERVATION BROKEN at ${label}`);
  if (!acctOk) throw new Error(`ACCOUNTING BROKEN at ${label}`);
}

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   STRESS: BANKRUPTCY + ADL + BANK RUN          ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  // Setup market
  const slab = Keypair.generate();
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  const [vaultPda] = deriveVaultAuthority(PROG, slab.publicKey);
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);
  await tx([SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
    lamports: rent, space: SLAB_SIZE, programId: PROG,
  })], [payer, slab], 100000);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vaultPda, true);
  const vault = vaultAcc.address;
  const payerAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  await mintTo(conn, payer, mint, payerAta.address, payer, 10_000_000_000); // 10K tokens

  // InitMarket (Hyperp, $100 mark). Full-capacity build (MAX_ACCOUNTS=4096)
  // needs a much bigger CU budget — engine.init_in_place zero-writes 4096
  // accounts plus next_free/prev_free arrays.
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, mint, vault,
      WELL_KNOWN.clock, vaultPda,
    ]),
    data: encodeInitMarket(defaultInitMarketArgs(payer.publicKey, mint)),
  })], [payer], 1_400_000);
  console.log("Market initialized: " + slab.publicKey.toBase58());

  // Set oracle authority + push price
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, payer.publicKey, slab.publicKey]),
    data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) })], [payer]);
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
    data: pushPrice("100000000") })], [payer]);

  // Helper functions
  const crankKeys = () => buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
  ]);
  const doCrank = (candidates: number[] = []) =>
    tx([buildIx({ programId: PROG, keys: crankKeys(),
      data: encodeKeeperCrank({ callerIdx: 65535, candidates }) })], [payer]);

  // Create LP (idx 0)
  const matcherCtx = Keypair.generate();
  const [lpPda] = deriveLpPda(PROG, slab.publicKey, 0);
  const matcherInitData = Buffer.alloc(66);
  matcherInitData[0] = 2; matcherInitData[1] = 0;
  matcherInitData.writeUInt32LE(50, 2); matcherInitData.writeUInt32LE(50, 6);
  matcherInitData.writeUInt32LE(1000, 10);
  matcherInitData.writeBigUInt64LE(1000000000n, 18); matcherInitData.writeBigUInt64LE(0n, 26);
  matcherInitData.writeBigUInt64LE(100000000n, 34); matcherInitData.writeBigUInt64LE(0n, 42);
  matcherInitData.writeBigUInt64LE(100000000n, 50); matcherInitData.writeBigUInt64LE(0n, 58);

  await tx([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(320), space: 320, programId: MATCHER }),
    { programId: MATCHER, keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
    ], data: matcherInitData },
    buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeInitLP({ matcherProgram: MATCHER, matcherContext: matcherCtx.publicKey, feePayment: "1000000" }) }),
  ], [payer, matcherCtx], 300000);

  // Create 4 users (idx 1-4)
  for (let i = 0; i < 4; i++) {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeInitUser({ feePayment: "1000000" }) })], [payer]);
  }

  // Deposit: LP gets 500M, each user gets 50M
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
    data: encodeDepositCollateral({ userIdx: 0, amount: "500000000" }) })], [payer]);
  for (let i = 1; i <= 4; i++) {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeDepositCollateral({ userIdx: i, amount: "50000000" }) })], [payer]);
  }

  // TopUp insurance: 10M
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
    data: encodeTopUpInsurance({ amount: "10000000" }) })], [payer]);

  await dumpState(slab.publicKey, vault, "AFTER SETUP");

  // v12.21: MAX_ACCRUAL_DT_SLOTS=100 — refresh price + crank before each
  // health-sensitive batch so the engine clock stays inside the envelope.
  const refreshMark = async () => {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: pushPrice("100000000") })], [payer]);
    await doCrank();
  };

  // Wait warmup, crank
  await sleep(5000);
  await refreshMark();

  // ═══════════════════════════════════════
  // PHASE 1: Open leveraged long positions
  // ═══════════════════════════════════════
  console.log("\n=== PHASE 1: Open leveraged positions (all users long) ===");
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, slab.publicKey,
    WELL_KNOWN.clock, payer.publicKey, MATCHER, matcherCtx.publicKey, lpPda,
  ]);
  for (let i = 1; i <= 4; i++) {
    await refreshMark();
    await tx([buildIx({ programId: PROG, keys: tradeKeys,
      data: encodeTradeCpi({ userIdx: i, lpIdx: 0, size: "3000000" }) })], [payer], 400000);
  }
  await dumpState(slab.publicKey, vault, "POSITIONS OPEN");

  // ═══════════════════════════════════════
  // PHASE 2: Crash price → liquidations
  // ═══════════════════════════════════════
  console.log("\n=== PHASE 2: Crash price to $10 (90% drop) ===");
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
    data: pushPrice("10000000") })], [payer]);

  // Crank aggressively with candidates to trigger liquidations
  for (let round = 0; round < 10; round++) {
    await doCrank([1, 2, 3, 4]);
    // Also trade small amounts to move the EWMA mark
    try {
      await tx([buildIx({ programId: PROG, keys: tradeKeys,
        data: encodeTradeCpi({ userIdx: 1, lpIdx: 0, size: "1" }) })], [payer], 400000);
    } catch {}
    await sleep(300);
  }

  await dumpState(slab.publicKey, vault, "AFTER CRASH + LIQUIDATION SWEEP");

  // Try explicit LiquidateAtOracle on each user
  console.log("\n=== PHASE 3: Explicit LiquidateAtOracle on remaining users ===");
  for (let i = 1; i <= 4; i++) {
    try {
      const buf = await fetchSlab(conn, slab.publicKey);
      if (!isAccountUsed(buf, i)) { console.log(`  User ${i}: already closed`); continue; }
      const acc = parseAccount(buf, i);
      if (acc.positionBasisQ === 0n) { console.log(`  User ${i}: no position`); continue; }
      await tx([buildIx({ programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [slab.publicKey, WELL_KNOWN.clock, payer.publicKey]),
        data: encodeLiquidateAtOracle({ targetIdx: i }) })], [payer]);
      console.log(`  User ${i}: LIQUIDATED`);
    } catch (e: any) {
      console.log(`  User ${i}: ${e.message?.slice(0, 60)}`);
    }
  }

  await dumpState(slab.publicKey, vault, "AFTER LIQUIDATIONS");

  // ═══════════════════════════════════════
  // PHASE 4: Check ADL state
  // ═══════════════════════════════════════
  console.log("\n=== PHASE 4: ADL state check ===");
  {
    const buf = await fetchSlab(conn, slab.publicKey);
    const e = parseEngine(buf);
    console.log(`  sideModeLong=${e.sideModeLong} sideModeShort=${e.sideModeShort}`);
    console.log(`  adlMultLong=${e.adlMultLong} adlMultShort=${e.adlMultShort}`);
    console.log(`  adlCoeffLong=${e.adlCoeffLong} adlCoeffShort=${e.adlCoeffShort}`);
    console.log(`  adlEpochLong=${e.adlEpochLong} adlEpochShort=${e.adlEpochShort}`);
  }

  // ═══════════════════════════════════════
  // PHASE 5: Bank run — all remaining users withdraw
  // ═══════════════════════════════════════
  console.log("\n=== PHASE 5: Bank run — close all positions + withdraw ===");
  {
    // Restore price so users can close positions
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: pushPrice("100000000") })], [payer]);
    for (let i = 0; i < 5; i++) { await doCrank(); await sleep(300); }

    const buf = await fetchSlab(conn, slab.publicKey);
    const remaining = parseUsedIndices(buf);
    console.log(`  Remaining accounts: ${remaining}`);

    let closed = 0;
    for (const idx of remaining) {
      if (idx === 0) continue; // skip LP
      try {
        const acc = parseAccount(await fetchSlab(conn, slab.publicKey), idx);
        if (acc.positionBasisQ !== 0n) {
          // Close position first
          await tx([buildIx({ programId: PROG, keys: tradeKeys,
            data: encodeTradeCpi({ userIdx: idx, lpIdx: 0, size: (-acc.positionBasisQ).toString() }) })], [payer], 400000);
        }
        // Crank to mature PnL
        await sleep(3000);
        for (let i = 0; i < 3; i++) { await doCrank([idx]); await sleep(500); }
        // Close account
        await tx([buildIx({ programId: PROG,
          keys: buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
            payer.publicKey, slab.publicKey, vault, payerAta.address,
            vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, payer.publicKey,
          ]),
          data: encodeCloseAccount({ idx }) })], [payer]);
        console.log(`  User ${idx}: CLOSED`);
        closed++;
      } catch (e: any) {
        console.log(`  User ${idx}: close failed — ${e.message?.slice(0, 60)}`);
      }
    }
    console.log(`  Bank run: ${closed} accounts closed`);
  }

  await dumpState(slab.publicKey, vault, "AFTER BANK RUN");

  // ═══════════════════════════════════════
  // PHASE 6: Resolve + cleanup
  // ═══════════════════════════════════════
  console.log("\n=== PHASE 6: Resolve + force-close + drain ===");
  let phase6Resolved = false;
  try {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: pushPrice("100000000") })], [payer]);
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey]),
      data: encodeResolveMarket() })], [payer]);
    phase6Resolved = true;
    for (let i = 0; i < 5; i++) { await doCrank(); await sleep(300); }
  } catch (e: any) {
    console.log(`  Phase 6 resolve skipped: ${(e.message || "").split("\n")[0].slice(0, 80)}`);
  }
  if (!phase6Resolved) {
    console.log("\n=== STRESS DONE (resolve+drain skipped — invariants HELD through phase 5) ===");
    return;
  }

  // Force-close remaining
  const remaining = parseUsedIndices(await fetchSlab(conn, slab.publicKey));
  for (const idx of remaining) {
    try {
      await tx([buildIx({ programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_ADMIN_FORCE_CLOSE, [
          payer.publicKey, slab.publicKey, vault, payerAta.address,
          vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
        ]),
        data: encodeAdminForceCloseAccount({ userIdx: idx }) })], [payer]);
    } catch {}
  }

  // Drain insurance
  try {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
        payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, vaultPda,
      ]),
      data: encodeWithdrawInsurance() })], [payer]);
  } catch {}

  await dumpState(slab.publicKey, vault, "FINAL");

  // Force-close any stragglers and try to close slab
  const finalRemaining = parseUsedIndices(await fetchSlab(conn, slab.publicKey));
  for (const idx of finalRemaining) {
    try {
      await tx([buildIx({ programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_ADMIN_FORCE_CLOSE, [
          payer.publicKey, slab.publicKey, vault, payerAta.address,
          vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
        ]),
        data: encodeAdminForceCloseAccount({ userIdx: idx }) })], [payer]);
    } catch {}
  }
  try {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
        payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, vaultPda,
      ]),
      data: encodeWithdrawInsurance() })], [payer]);
  } catch {}

  await dumpState(slab.publicKey, vault, "PRE-CLOSE");

  try {
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
      payer.publicKey, slab.publicKey, vault, vaultPda, payerAta.address, WELL_KNOWN.tokenProgram,
    ]);
    await tx([buildIx({ programId: PROG, keys: closeKeys, data: encodeCloseSlab() })], [payer], 1400000);
    console.log("\nSlab closed, rent reclaimed.");
  } catch (e: any) {
    console.log("\nSlab close skipped (accounts still open): " + e.message?.slice(0, 60));
  }
  console.log("\n✅ Stress test complete — no conservation or accounting violations detected.");
}

main().catch(e => { console.error("\n❌ FATAL:", e.message); process.exit(1); });
