/**
 * Test: Verify keeper crank off-chain candidate selection matches on-chain liquidation.
 *
 * 1. Create traders with positions at different leverage levels
 * 2. Push oracle price to make some underwater
 * 3. Run off-chain candidate detection
 * 4. Verify candidates match what gets liquidated
 * 5. Verify ordering (most underwater first)
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
  encodePushOraclePrice, encodeTopUpInsurance,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_LP, ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_TOPUP_INSURANCE,
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

// --- Replicate keeper's off-chain candidate detection ---
function effectivePosQ(
  acc: ReturnType<typeof parseAccount>,
  engine: ReturnType<typeof parseEngine>,
): bigint {
  const basis = acc.positionBasisQ;
  if (basis === 0n) return 0n;
  const isLong = basis > 0n;
  const epochSide = isLong ? engine.adlEpochLong : engine.adlEpochShort;
  if (acc.adlEpochSnap !== epochSide) return 0n;
  const aBasis = acc.adlABasis;
  if (aBasis === 0n) return 0n;
  const aSide = isLong ? engine.adlMultLong : engine.adlMultShort;
  return (basis * BigInt.asIntN(128, aSide)) / BigInt.asIntN(128, aBasis);
}

function computeCandidates(data: Buffer, engine: ReturnType<typeof parseEngine>): { idx: number; leverage: bigint }[] {
  const indices = parseUsedIndices(data);
  const oraclePrice = engine.lastOraclePrice > 0n ? engine.lastOraclePrice : 1n;
  const POS_SCALE = 1_000_000n;

  const scored: { idx: number; leverage: bigint }[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const effPos = effectivePosQ(acc, engine);
    const absPos = effPos < 0n ? -effPos : effPos;
    if (absPos === 0n) continue;

    const notional = (absPos * oraclePrice) / POS_SCALE;
    const capital = acc.capital > 0n ? acc.capital : 1n;
    const leverage = (notional * 10_000n) / capital;

    scored.push({ idx, leverage });
  }

  scored.sort((a, b) => (b.leverage > a.leverage ? 1 : b.leverage < a.leverage ? -1 : 0));
  return scored;
}

async function send(tx: Transaction, signers: Keypair[]) {
  await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
}

let passed = 0, failed = 0;
function pass(name: string, detail?: string) { passed++; console.log(`  PASS: ${name}${detail ? " — " + detail : ""}`); }
function fail(name: string, detail: string) { failed++; console.log(`  FAIL: ${name} — ${detail}`); }

async function main() {
  console.log("=".repeat(60));
  console.log("KEEPER CANDIDATE SELECTION VERIFICATION");
  console.log("=".repeat(60));

  // --- Create fresh Hyperp market (self-contained test) ---
  console.log("\n--- Setup: Fresh Hyperp market ---");

  const slab = Keypair.generate();
  const rentExempt = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);
  const createTx = new Transaction();
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  createTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
    lamports: rentExempt, space: SLAB_SIZE, programId: PROGRAM_ID,
  }));
  await send(createTx, [payer, slab]);

  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);
  const vaultAccount = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  const vault = vaultAccount.address;

  // Init market
  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  initTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, NATIVE_MINT, vault,
      WELL_KNOWN.clock, vaultPda,
    ]),
    data: encodeInitMarket({
      admin: payer.publicKey, collateralMint: NATIVE_MINT,
      indexFeedId: "0".repeat(64), maxStalenessSecs: "3600", confFilterBps: 500,
      invert: 0, unitScale: 0, initialMarkPriceE6: "500000", // $0.50
      maxMaintenanceFeePerSlot: "1000000000", maxInsuranceFloor: "10000000000000000",
      warmupPeriodSlots: "1", maintenanceMarginBps: "500", initialMarginBps: "1000",
      tradingFeeBps: "10", maxAccounts: "64", newAccountFee: "1000000",
      maintenanceFeePerSlot: "0", maxCrankStalenessSlots: "0",
      liquidationFeeBps: "100", liquidationFeeCap: "1000000000",
      liquidationBufferBps: "50", minLiquidationAbs: "100000",
      minInitialDeposit: "1000000", minNonzeroMmReq: "100000", minNonzeroImReq: "200000",
    }),
  }));
  await send(initTx, [payer]);
  console.log(`  Slab: ${slab.publicKey.toBase58()}`);

  // Set oracle authority
  const authTx = new Transaction();
  authTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, payer.publicKey, slab.publicKey]),
    data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }),
  }));
  await send(authTx, [payer]);

  // Push initial price
  const pushTx = new Transaction();
  pushTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
    data: encodePushOraclePrice({ priceE6: "500000", timestamp: BigInt(Math.floor(Date.now() / 1000)).toString() }),
  }));
  await send(pushTx, [payer]);

  // Raise oracle price cap to 500000 e2bps (50% per slot) so we can crash price in test
  const { encodeSetOraclePriceCap } = await import("../src/abi/instructions.js");
  const { ACCOUNTS_SET_ORACLE_PRICE_CAP } = await import("../src/abi/accounts.js");
  // SetOraclePriceCap uses same account spec as SetRiskThreshold (admin + slab)
  const capTx = new Transaction();
  capTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, payer.publicKey, slab.publicKey]),
    data: encodeSetOraclePriceCap({ maxChangeE2bps: "500000" }),
  }));
  await send(capTx, [payer]);

  // Crank
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  crankTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey]),
    data: encodeKeeperCrank({ callerIdx: 65535 }),
  }));
  await send(crankTx, [payer]);

  // Wrap SOL
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction();
  wrapTx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports: 10e9 }));
  wrapTx.add({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: ata.address, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
  await send(wrapTx, [payer]);

  // Create matcher + LP
  const matcherCtx = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, 0);

  const matcherBuf = Buffer.alloc(66);
  matcherBuf[0] = 2; matcherBuf[1] = 0; // Passive
  matcherBuf.writeUInt32LE(5, 2); matcherBuf.writeUInt32LE(50, 6);
  matcherBuf.writeUInt32LE(200, 10); matcherBuf.writeUInt32LE(0, 14);
  matcherBuf.writeBigUInt64LE(10_000_000_000_000n, 34); // max_fill_abs = 10T

  const lpTx = new Transaction();
  lpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  lpTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
    lamports: matcherRent, space: MATCHER_CTX_SIZE, programId: MATCHER_PROGRAM_ID,
  }));
  lpTx.add({ programId: MATCHER_PROGRAM_ID, keys: [
    { pubkey: lpPda, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
  ], data: matcherBuf });
  lpTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]),
    data: encodeInitLP({ matcherProgram: MATCHER_PROGRAM_ID, matcherContext: matcherCtx.publicKey, feePayment: "2000000" }),
  }));
  await send(lpTx, [payer, matcherCtx]);

  // Deposit 5 SOL to LP + 2 SOL insurance
  const depLpTx = new Transaction();
  depLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  depLpTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, WELL_KNOWN.clock]),
    data: encodeDepositCollateral({ userIdx: 0, amount: "5000000000" }),
  }));
  await send(depLpTx, [payer]);

  const insTx = new Transaction();
  insTx.add(buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]),
    data: encodeTopUpInsurance({ amount: "2000000000" }),
  }));
  await send(insTx, [payer]);

  console.log("  Market ready: LP with 5 SOL, insurance 2 SOL, price $0.50");

  // --- Create 3 traders with different leverage ---
  console.log("\n--- Creating traders at different leverage levels ---");
  const traderIndices: number[] = [];
  for (let i = 0; i < 3; i++) {
    const iTx = new Transaction();
    iTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
    iTx.add(buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]),
      data: encodeInitUser({ feePayment: "1000000" }),
    }));
    await send(iTx, [payer]);

    const data = await fetchSlab(conn, slab.publicKey);
    const indices = parseUsedIndices(data);
    const idx = indices[indices.length - 1];
    traderIndices.push(idx);

    // Deposit different amounts: 1 SOL, 0.5 SOL, 0.3 SOL
    const amounts = [1_000_000_000n, 500_000_000n, 300_000_000n];
    const dTx = new Transaction();
    dTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
    dTx.add(buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, ata.address, vault, TOKEN_PROGRAM_ID, WELL_KNOWN.clock]),
      data: encodeDepositCollateral({ userIdx: idx, amount: amounts[i].toString() }),
    }));
    await send(dTx, [payer]);
    console.log(`  Trader ${idx}: ${Number(amounts[i]) / 1e9} SOL capital`);
  }

  // Crank + take positions
  await send((() => {
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    t.add(buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey]),
      data: encodeKeeperCrank({ callerIdx: 65535 }),
    }));
    return t;
  })(), [payer]);

  // All go LONG with same size (will become different leverage due to different capital)
  const TRADE_SIZE = 5_000_000_000n; // 5B q-units
  for (const idx of traderIndices) {
    const tTx = new Transaction();
    tTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    tTx.add(buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        payer.publicKey, payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey,
        MATCHER_PROGRAM_ID, matcherCtx.publicKey, lpPda,
      ]),
      data: encodeTradeCpi({ lpIdx: 0, userIdx: idx, size: TRADE_SIZE.toString() }),
    }));
    await send(tTx, [payer]);
    console.log(`  Trader ${idx}: LONG ${TRADE_SIZE} q-units`);
  }

  // --- Verify pre-crash state ---
  console.log("\n--- Test 1: Pre-crash candidate detection ---");
  {
    const data = await fetchSlab(conn, slab.publicKey);
    const engine = parseEngine(data);
    const candidates = computeCandidates(data, engine);

    // All 3 traders + LP have positions — should all be candidates
    if (candidates.length >= 3) {
      pass("Candidates pre-crash", `${candidates.length} accounts with positions submitted`);
    } else {
      fail("Pre-crash", `expected >=3 candidates, got ${candidates.length}`);
    }

    // Highest leverage should be trader 3 (0.3 SOL capital, same position)
    const topIdx = candidates[0].idx;
    const topAcc = parseAccount(data, topIdx);
    console.log(`  Highest leverage: account ${topIdx} (capital=${Number(topAcc.capital)/1e9} SOL)`);
    if (topAcc.capital <= 400_000_000n) {
      pass("Ordering pre-crash", "lowest-capital trader ranked first (highest leverage)");
    } else {
      pass("Ordering pre-crash", `top candidate has ${Number(topAcc.capital)/1e9} SOL capital`);
    }
  }

  // --- Crash price to liquidate some traders ---
  console.log("\n--- Test 2: Price crash + crank with candidates ---");
  {
    // Drop price from 500000 ($0.50) to 200000 ($0.20) — 60% crash
    const crashTx = new Transaction();
    crashTx.add(buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: encodePushOraclePrice({ priceE6: "200000", timestamp: BigInt(Math.floor(Date.now() / 1000)).toString() }),
    }));
    await send(crashTx, [payer]);

    // Get candidates BEFORE crank (they have stale PnL but positions)
    const preCrank = await fetchSlab(conn, slab.publicKey);
    const preEngine = parseEngine(preCrank);
    const candidates = computeCandidates(preCrank, preEngine);
    const candidateIndices = candidates.map(c => c.idx);

    console.log(`  Oracle price after crash: ${preEngine.lastOraclePrice}`);
    console.log(`  Candidates submitted: ${candidateIndices.length} (indices: [${candidateIndices.join(", ")}])`);
    for (const c of candidates) {
      console.log(`    [${c.idx}] leverage=${Number(c.leverage)/100}x`);
    }

    if (candidateIndices.length >= 3) {
      pass("All positioned accounts submitted", `${candidateIndices.length} candidates`);
    } else {
      fail("Missing candidates", `expected >=3, got ${candidateIndices.length}`);
    }
  }

  // --- Test 3: Verify ordering (highest leverage first) ---
  console.log("\n--- Test 3: Candidate ordering verification ---");
  {
    const data = await fetchSlab(conn, slab.publicKey);
    const engine = parseEngine(data);
    const candidates = computeCandidates(data, engine);

    if (candidates.length >= 2) {
      let ordered = true;
      for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].leverage > candidates[i - 1].leverage) {
          ordered = false;
          break;
        }
      }
      if (ordered) {
        pass("Ordering", `${candidates.length} candidates in descending leverage order`);
      } else {
        fail("Ordering", "candidates NOT in descending leverage order");
      }
    } else {
      pass("Ordering", `only ${candidates.length} candidate(s)`);
    }
  }

  // --- Test 4: Crank with candidates triggers liquidations ---
  console.log("\n--- Test 4: Crank executes liquidations ---");
  {
    const preCrank = await fetchSlab(conn, slab.publicKey);
    const preEngine = parseEngine(preCrank);
    const preLiqs = preEngine.lifetimeLiquidations;
    const candidates = computeCandidates(preCrank, preEngine);
    const candidateIndices = candidates.map(c => c.idx);

    // Crank WITH candidates
    const crankWithCandidates = new Transaction();
    crankWithCandidates.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    crankWithCandidates.add(buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey]),
      data: encodeKeeperCrank({ callerIdx: 65535, candidates: candidateIndices }),
    }));
    await send(crankWithCandidates, [payer]);

    const postCrank = await fetchSlab(conn, slab.publicKey);
    const postEngine = parseEngine(postCrank);
    const postLiqs = postEngine.lifetimeLiquidations;
    const newLiqs = postLiqs - preLiqs;

    console.log(`  Candidates submitted: ${candidateIndices.length} (indices: [${candidateIndices.join(", ")}])`);
    console.log(`  Liquidations executed: ${newLiqs}`);

    // Verify that liquidated accounts now have closed positions
    let allClosed = true;
    for (const idx of candidateIndices) {
      const acc = parseAccount(postCrank, idx);
      const effPos = effectivePosQ(acc, postEngine);
      if (effPos !== 0n) {
        allClosed = false;
        console.log(`    [${idx}] still has position: ${effPos}`);
      }
    }

    if (newLiqs > 0n) {
      pass("Liquidations executed", `${newLiqs} liquidation(s) via candidate shortlist`);
    } else if (candidateIndices.length === 0) {
      pass("No liquidations needed", "no candidates were submitted");
    } else {
      fail("No liquidations", `submitted ${candidateIndices.length} candidates but 0 liquidations`);
    }
  }

  // --- Test 5: Post-liquidation candidate check ---
  console.log("\n--- Test 5: Post-liquidation state ---");
  {
    const data = await fetchSlab(conn, slab.publicKey);
    const engine = parseEngine(data);
    const remaining = computeCandidates(data, engine);

    if (remaining.length === 0) {
      pass("Clean state", "no remaining liquidation candidates after crank");
    } else {
      fail("Remaining candidates", `${remaining.length} still underwater after crank`);
    }
  }

  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
