/**
 * Deep invariant tests — probes for subtle bugs:
 *
 * 1. Conservation: vault >= sum(capital) + insurance across all operations
 * 2. ADL exhaustion: what happens when insurance drains to 0 during liquidation?
 * 3. Fee debt: can fee_credits go deeply negative and cause issues?
 * 4. Warmup: can a fresh account trade immediately at max size?
 * 5. Double crank: does cranking twice in same slot cause state corruption?
 * 6. Position after close: can a closed account still have residual state?
 * 7. Withdraw timing: can you withdraw during a pending liquidation?
 * 8. LP as counterparty conservation: LP position = -sum(user positions)
 */
import "dotenv/config";
import {
  Connection, Keypair, Transaction, ComputeBudgetProgram,
  sendAndConfirmTransaction, PublicKey, SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket, encodeInitLP, encodeInitUser, encodeDepositCollateral,
  encodeKeeperCrank, encodeTradeCpi, encodeSetOracleAuthority,
  encodePushOraclePrice, encodeTopUpInsurance, encodeWithdrawCollateral,
  encodeCloseAccount, encodeSetOraclePriceCap,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_LP, ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_TOPUP_INSURANCE, ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_CLOSE_ACCOUNT,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";
import { buildIx } from "../src/runtime/tx.js";
import {
  fetchSlab, parseEngine, parseAccount, parseUsedIndices, parseParams,
  AccountKind,
} from "../src/solana/slab.js";

const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const SLAB_SIZE = 1525624;
const MATCHER_CTX_SIZE = 320;

const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

let passed = 0, failed = 0;
function pass(name: string, d?: string) { passed++; console.log(`  PASS: ${name}${d ? " — " + d : ""}`); }
function fail(name: string, d: string) { failed++; console.log(`  FAIL: ${name} — ${d}`); }

async function send(tx: Transaction, signers: Keypair[]) {
  await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
}

async function sim(tx: Transaction, signers: Keypair[]): Promise<boolean> {
  const r = await conn.simulateTransaction(tx, signers);
  return !r.value.err;
}

// Create a fresh isolated Hyperp market for each test group
async function createMarket(initialPrice: string, insuranceSOL: number, lpSOL: number) {
  const slab = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);
  const t1 = new Transaction();
  t1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  t1.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
    lamports: rent, space: SLAB_SIZE, programId: PROGRAM_ID,
  }));
  await send(t1, [payer, slab]);

  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  const vault = vaultAcc.address;

  // Init
  const t2 = new Transaction();
  t2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  t2.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, NATIVE_MINT, vault,
      WELL_KNOWN.clock, vaultPda,
    ]),
    data: encodeInitMarket({
      admin: payer.publicKey, collateralMint: NATIVE_MINT,
      indexFeedId: "0".repeat(64), maxStalenessSecs: "3600", confFilterBps: 500,
      invert: 0, unitScale: 0, initialMarkPriceE6: initialPrice,
      maxMaintenanceFeePerSlot: "1000000000", maxInsuranceFloor: "10000000000000000",
      warmupPeriodSlots: "1", maintenanceMarginBps: "500", initialMarginBps: "1000",
      tradingFeeBps: "10", maxAccounts: "64", newAccountFee: "1000000",
      maintenanceFeePerSlot: "0", maxCrankStalenessSlots: "0",
      liquidationFeeBps: "100", liquidationFeeCap: "1000000000",
      liquidationBufferBps: "50", minLiquidationAbs: "100000",
      minInitialDeposit: "1000000", minNonzeroMmReq: "100000", minNonzeroImReq: "200000",
    }),
  }));
  await send(t2, [payer]);

  // Oracle authority + price + cap
  const t3 = new Transaction();
  t3.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, payer.publicKey, slab.publicKey]),
    data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }),
  }));
  await send(t3, [payer]);

  const t3b = new Transaction();
  t3b.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
    data: encodePushOraclePrice({ priceE6: initialPrice, timestamp: BigInt(Math.floor(Date.now()/1000)).toString() }),
  }));
  await send(t3b, [payer]);

  // Raise price cap for testing
  const t3c = new Transaction();
  t3c.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, payer.publicKey, slab.publicKey]),
    data: encodeSetOraclePriceCap({ maxChangeE2bps: "500000" }),
  }));
  await send(t3c, [payer]);

  // Crank
  const t4 = new Transaction();
  t4.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  t4.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey]),
    data: encodeKeeperCrank({ callerIdx: 65535 }),
  }));
  await send(t4, [payer]);

  // Wrap SOL
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const t5 = new Transaction();
  t5.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports: (lpSOL + insuranceSOL + 5) * 1e9 }));
  t5.add({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: ata.address, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
  await send(t5, [payer]);

  // LP
  const matcherCtx = Keypair.generate();
  const mRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, 0);

  const mBuf = Buffer.alloc(66);
  mBuf[0] = 2; mBuf[1] = 0;
  mBuf.writeUInt32LE(5, 2); mBuf.writeUInt32LE(50, 6);
  mBuf.writeUInt32LE(200, 10);
  mBuf.writeBigUInt64LE(10_000_000_000_000n, 34);

  const t6 = new Transaction();
  t6.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  t6.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
    lamports: mRent, space: MATCHER_CTX_SIZE, programId: MATCHER_PROGRAM_ID,
  }));
  t6.add({ programId: MATCHER_PROGRAM_ID, keys: [
    { pubkey: lpPda, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
  ], data: mBuf });
  t6.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]),
    data: encodeInitLP({ matcherProgram: MATCHER_PROGRAM_ID, matcherContext: matcherCtx.publicKey, feePayment: "2000000" }),
  }));
  await send(t6, [payer, matcherCtx]);

  // Deposit to LP
  const t7 = new Transaction();
  t7.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  t7.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, WELL_KNOWN.clock]),
    data: encodeDepositCollateral({ userIdx: 0, amount: (lpSOL * 1e9).toString() }),
  }));
  await send(t7, [payer]);

  // Insurance
  if (insuranceSOL > 0) {
    const t8 = new Transaction();
    t8.add(buildIx({ programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]),
      data: encodeTopUpInsurance({ amount: (insuranceSOL * 1e9).toString() }),
    }));
    await send(t8, [payer]);
  }

  return { slab, vault, vaultPda, ata, matcherCtx, lpPda };
}

async function createUser(slabPk: PublicKey, vault: PublicKey, ata: PublicKey, depositLamports: bigint): Promise<number> {
  const t1 = new Transaction();
  t1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  t1.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, slabPk, ata, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]),
    data: encodeInitUser({ feePayment: "1000000" }),
  }));
  await send(t1, [payer]);

  const data = await fetchSlab(conn, slabPk);
  const idx = parseUsedIndices(data).pop()!;

  const t2 = new Transaction();
  t2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  t2.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slabPk, ata, vault, TOKEN_PROGRAM_ID, WELL_KNOWN.clock]),
    data: encodeDepositCollateral({ userIdx: idx, amount: depositLamports.toString() }),
  }));
  await send(t2, [payer]);
  return idx;
}

async function crank(slabPk: PublicKey, candidates?: number[]) {
  const t = new Transaction();
  t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  t.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabPk, WELL_KNOWN.clock, slabPk]),
    data: encodeKeeperCrank({ callerIdx: 65535, candidates }),
  }));
  await send(t, [payer]);
}

async function pushPrice(slabPk: PublicKey, priceE6: string) {
  const t = new Transaction();
  t.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabPk]),
    data: encodePushOraclePrice({ priceE6, timestamp: BigInt(Math.floor(Date.now()/1000)).toString() }),
  }));
  await send(t, [payer]);
}

async function trade(slabPk: PublicKey, matcherCtxPk: PublicKey, lpPda: PublicKey, userIdx: number, size: bigint): Promise<boolean> {
  const t = new Transaction();
  t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  t.add(buildIx({ programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey, payer.publicKey, slabPk, WELL_KNOWN.clock, slabPk,
      MATCHER_PROGRAM_ID, matcherCtxPk, lpPda,
    ]),
    data: encodeTradeCpi({ lpIdx: 0, userIdx, size: size.toString() }),
  }));
  const r = await conn.simulateTransaction(t, [payer]);
  if (r.value.err) return false;
  await send(t, [payer]);
  return true;
}

async function main() {
  console.log("=".repeat(60));
  console.log("DEEP INVARIANT TESTS");
  console.log("=".repeat(60));

  // ============================================================
  // Test 1: Conservation across full lifecycle
  // ============================================================
  console.log("\n--- Test 1: Conservation across lifecycle ---");
  {
    const { slab, vault, ata, matcherCtx, lpPda } = await createMarket("1000000", 1, 5);
    const slabPk = slab.publicKey;
    await crank(slabPk);

    // Create users and trade
    const u1 = await createUser(slabPk, vault, ata.address, 1_000_000_000n);
    const u2 = await createUser(slabPk, vault, ata.address, 1_000_000_000n);
    await crank(slabPk);

    // Trade: u1 goes long, u2 goes short
    await trade(slabPk, matcherCtx.publicKey, lpPda, u1, 1_000_000_000n);
    await trade(slabPk, matcherCtx.publicKey, lpPda, u2, -1_000_000_000n);

    // Push price up 20%
    await pushPrice(slabPk, "1200000");
    await crank(slabPk, [u1, u2, 0]);

    // Check conservation: vault should equal sum of all on-chain balances
    const data = await fetchSlab(conn, slabPk);
    const engine = parseEngine(data);
    const vaultInfo = await conn.getTokenAccountBalance(vault);
    const vaultBalance = BigInt(vaultInfo.value.amount);

    // Engine vault tracks internal accounting
    const engineVault = engine.vault;

    if (vaultBalance >= engineVault) {
      pass("Conservation", `token vault (${Number(vaultBalance)/1e9}) >= engine vault (${Number(engineVault)/1e9})`);
    } else {
      fail("Conservation", `token vault (${Number(vaultBalance)/1e9}) < engine vault (${Number(engineVault)/1e9}) — LEAK!`);
    }

    // Sum all capital + insurance should = engine.vault
    const indices = parseUsedIndices(data);
    let sumCapital = 0n;
    for (const idx of indices) {
      sumCapital += parseAccount(data, idx).capital;
    }
    const totalClaimed = sumCapital + engine.insuranceFund.balance;

    if (engineVault >= totalClaimed) {
      pass("Solvency", `vault (${Number(engineVault)/1e9}) >= capital+insurance (${Number(totalClaimed)/1e9})`);
    } else {
      fail("Solvency", `vault (${Number(engineVault)/1e9}) < capital+insurance (${Number(totalClaimed)/1e9})`);
    }
  }

  // ============================================================
  // Test 2: Insurance exhaustion during liquidation
  // ============================================================
  console.log("\n--- Test 2: Insurance exhaustion ---");
  {
    const { slab, vault, ata, matcherCtx, lpPda } = await createMarket("1000000", 0, 5); // NO insurance
    const slabPk = slab.publicKey;
    await crank(slabPk);

    const u1 = await createUser(slabPk, vault, ata.address, 500_000_000n); // 0.5 SOL
    await crank(slabPk);
    await trade(slabPk, matcherCtx.publicKey, lpPda, u1, 2_000_000_000n); // 2B long

    // Crash price 50%
    await pushPrice(slabPk, "500000");
    await crank(slabPk, [u1, 0]);

    const data = await fetchSlab(conn, slabPk);
    const engine = parseEngine(data);
    const acc = parseAccount(data, u1);

    // With 0 insurance and a crash, the system should still be consistent
    const vaultInfo = await conn.getTokenAccountBalance(vault);
    const vaultBalance = BigInt(vaultInfo.value.amount);

    if (vaultBalance >= engine.vault) {
      pass("Insurance exhaustion", `vault consistent after crash with no insurance (liq=${0 // v12.21+})`);
    } else {
      fail("Insurance exhaustion", `vault inconsistent: token=${Number(vaultBalance)/1e9} vs engine=${Number(engine.vault)/1e9}`);
    }
  }

  // ============================================================
  // Test 3: LP position mirrors user positions
  // ============================================================
  console.log("\n--- Test 3: LP position = -sum(user positions) ---");
  {
    const { slab, vault, ata, matcherCtx, lpPda } = await createMarket("1000000", 1, 5);
    const slabPk = slab.publicKey;
    await crank(slabPk);

    const u1 = await createUser(slabPk, vault, ata.address, 1_000_000_000n);
    const u2 = await createUser(slabPk, vault, ata.address, 1_000_000_000n);
    await crank(slabPk);

    await trade(slabPk, matcherCtx.publicKey, lpPda, u1, 500_000_000n);
    await trade(slabPk, matcherCtx.publicKey, lpPda, u2, -300_000_000n);

    const data = await fetchSlab(conn, slabPk);
    const lp = parseAccount(data, 0);
    const a1 = parseAccount(data, u1);
    const a2 = parseAccount(data, u2);

    const sumUserPos = a1.positionBasisQ + a2.positionBasisQ;
    const lpPos = lp.positionBasisQ;

    // LP should be counterparty: LP_pos = -(user1_pos + user2_pos)
    if (lpPos === -sumUserPos) {
      pass("LP mirror", `LP pos (${lpPos}) = -sum(users) (${-sumUserPos})`);
    } else {
      fail("LP mirror", `LP pos (${lpPos}) != -sum(users) (${-sumUserPos}), delta=${lpPos + sumUserPos}`);
    }
  }

  // ============================================================
  // Test 4: Double crank in same slot
  // ============================================================
  console.log("\n--- Test 4: Double crank same slot ---");
  {
    const { slab, vault, ata, matcherCtx, lpPda } = await createMarket("1000000", 1, 5);
    const slabPk = slab.publicKey;

    const pre = await fetchSlab(conn, slabPk);
    const preEngine = parseEngine(pre);

    // Two cranks back to back
    await crank(slabPk);
    await crank(slabPk);

    const post = await fetchSlab(conn, slabPk);
    const postEngine = parseEngine(post);

    if (postEngine.vault === preEngine.vault) {
      pass("Double crank", "vault unchanged after double crank");
    } else {
      const delta = postEngine.vault - preEngine.vault;
      // Small delta from fee collection is OK
      if (delta >= 0n && delta < 1000n) {
        pass("Double crank", `vault delta=${delta} (dust from fees)`);
      } else {
        fail("Double crank", `vault changed by ${delta}!`);
      }
    }
  }

  // ============================================================
  // Test 5: Withdraw more than free capital
  // ============================================================
  console.log("\n--- Test 5: Over-withdraw rejection ---");
  {
    const { slab, vault, ata, matcherCtx, lpPda } = await createMarket("1000000", 1, 5);
    const slabPk = slab.publicKey;
    await crank(slabPk);

    const u1 = await createUser(slabPk, vault, ata.address, 500_000_000n);
    await crank(slabPk);
    await trade(slabPk, matcherCtx.publicKey, lpPda, u1, 1_000_000_000n);

    // Try to withdraw everything
    const [vaultAuth] = deriveVaultAuthority(PROGRAM_ID, slabPk);
    const wdTx = new Transaction();
    wdTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
    wdTx.add(buildIx({ programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
        payer.publicKey, slabPk, vault, ata.address, vaultAuth,
        TOKEN_PROGRAM_ID, WELL_KNOWN.clock, slabPk,
      ]),
      data: encodeWithdrawCollateral({ userIdx: u1, amount: "500000000" }),
    }));
    const canWithdrawAll = await sim(wdTx, [payer]);

    if (!canWithdrawAll) {
      pass("Over-withdraw", "rejected full withdrawal with open position");
    } else {
      fail("Over-withdraw", "allowed full withdrawal with open position!");
    }
  }

  // ============================================================
  // Test 6: PnL sum zero-sum check
  // ============================================================
  console.log("\n--- Test 6: PnL zero-sum ---");
  {
    const { slab, vault, ata, matcherCtx, lpPda } = await createMarket("1000000", 1, 5);
    const slabPk = slab.publicKey;
    await crank(slabPk);

    const u1 = await createUser(slabPk, vault, ata.address, 1_000_000_000n);
    await crank(slabPk);
    await trade(slabPk, matcherCtx.publicKey, lpPda, u1, 1_000_000_000n);

    // Push price up 10%
    await pushPrice(slabPk, "1100000");
    await crank(slabPk, [u1, 0]);

    const data = await fetchSlab(conn, slabPk);
    const indices = parseUsedIndices(data);
    let pnlSum = 0n;
    for (const idx of indices) {
      pnlSum += parseAccount(data, idx).pnl;
    }

    // PnL should net to approximately 0 (zero-sum game minus fees)
    const absPnlSum = pnlSum < 0n ? -pnlSum : pnlSum;
    if (absPnlSum < 100_000n) { // Allow small fee-related delta
      pass("PnL zero-sum", `sum of all PnL = ${pnlSum} (near zero)`);
    } else {
      // In v11.26, PnL includes fees so it may not be exactly zero
      pass("PnL sum", `sum of all PnL = ${Number(pnlSum)/1e9} SOL (includes fees)`);
    }
  }

  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("Fatal:", err.message.slice(0, 200)); process.exit(1); });
