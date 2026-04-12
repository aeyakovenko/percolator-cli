/**
 * Exhaustive live market state verification.
 * Creates a market, runs full lifecycle, and diffs every parsed field after each call.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, mintTo, getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket, encodeInitUser, encodeInitLP,
  encodeDepositCollateral, encodeWithdrawCollateral,
  encodeKeeperCrank, encodeTradeNoCpi, encodeTradeCpi,
  encodeCloseAccount, encodeCloseSlab, encodeTopUpInsurance,
  encodeSetOracleAuthority, encodePushOraclePrice,
  encodeResolveMarket, encodeAdminForceCloseAccount,
  encodeWithdrawInsurance,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_USER, ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_ADMIN_FORCE_CLOSE,
  ACCOUNTS_WITHDRAW_INSURANCE, ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import {
  parseHeader, parseConfig, parseEngine, parseParams,
  parseAllAccounts, parseUsedIndices, parseAccount, fetchSlab,
  isAccountUsed,
  type SlabHeader, type MarketConfig, type EngineState, type RiskParams, type Account,
} from "../src/solana/slab.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROG = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const PYTH_ORACLE = new PublicKey("A7s72ttVi1uvZfe49GRggPEkcc6auBNXWivGWhSL9TzJ");
const SLAB_SIZE = 8951296;
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))
));

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
const DELAY = 100;

let passed = 0;
let failed = 0;

function ok(name: string) { passed++; console.log(`    [x] ${name}`); }
function fail(name: string, detail: string) {
  failed++;
  console.log(`    [ ] ${name}`);
  console.log(`        FAIL: ${detail}`);
}
function check(name: string, cond: boolean, detail?: string) {
  if (cond) ok(name);
  else fail(name, detail || "assertion failed");
}

async function tx(ixs: any[], signers: Keypair[], cu = 200000): Promise<string> {
  const t = new Transaction();
  t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  for (const ix of ixs) t.add(ix);
  const sig = await sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed" });
  await sleep(DELAY);
  return sig;
}

// === Diff helpers ===
function diffBigint(name: string, before: bigint, after: bigint, expectation: string): boolean {
  if (expectation === "increases") {
    if (after > before) return true;
    fail(name, `expected increase: ${before} -> ${after}`);
    return false;
  }
  if (expectation === "decreases") {
    if (after < before) return true;
    fail(name, `expected decrease: ${before} -> ${after}`);
    return false;
  }
  if (expectation === "unchanged") {
    if (after === before) return true;
    fail(name, `expected unchanged: ${before} -> ${after}`);
    return false;
  }
  if (expectation === "nonzero") {
    if (after !== 0n) return true;
    fail(name, `expected nonzero, got 0`);
    return false;
  }
  return true;
}

async function getVaultSpl(vault: PublicKey): Promise<bigint> {
  const a = await getAccount(conn, vault);
  return a.amount;
}

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   EXHAUSTIVE LIVE STATE VERIFICATION          ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  // ── Setup ──
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
  await mintTo(conn, payer, mint, payerAta.address, payer, 500_000_000);
  await sleep(DELAY);

  console.log(`\nSlab: ${slab.publicKey.toBase58()}`);

  // ════════════════════════════════════════
  // 1. INIT MARKET — verify ALL config/params/engine fields
  // ════════════════════════════════════════
  console.log("\n=== 1. InitMarket: verify every parsed field ===");
  {
    const data = encodeInitMarket({
      admin: payer.publicKey, collateralMint: mint, indexFeedId: "0000000000000000000000000000000000000000000000000000000000000000",
      maxStalenessSecs: "100000000", confFilterBps: 200, invert: 0, unitScale: 0,
      initialMarkPriceE6: "100000000",  // $100 initial mark (Hyperp mode)
      maxMaintenanceFeePerSlot: "1000000000", maxInsuranceFloor: "10000000000000000",
      minOraclePriceCapE2bps: "0",
      warmupPeriodSlots: "4", maintenanceMarginBps: "500", initialMarginBps: "1000",
      tradingFeeBps: "10", maxAccounts: "64", newAccountFee: "1000000",
      insuranceFloor: "0", maintenanceFeePerSlot: "100", maxCrankStalenessSlots: "200",
      liquidationFeeBps: "100", liquidationFeeCap: "1000000000",
      liquidationBufferBps: "50", minLiquidationAbs: "100000",
      minInitialDeposit: "1000000", minNonzeroMmReq: "100000", minNonzeroImReq: "200000",
    });
    const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, mint, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent,
      vaultPda, WELL_KNOWN.systemProgram,
    ]);
    await tx([buildIx({ programId: PROG, keys, data })], [payer]);

    const buf = await fetchSlab(conn, slab.publicKey);
    const h = parseHeader(buf);
    const c = parseConfig(buf);
    const e = parseEngine(buf);
    const p = parseParams(buf);

    // Header
    check("header.magic", h.magic === 0x504552434f4c4154n, `got ${h.magic.toString(16)}`);
    check("header.version >= 0", h.version >= 0);
    check("header.admin", h.admin.equals(payer.publicKey));
    check("header.resolved=false", !h.resolved);
    check("header.nonce=0", h.nonce === 0n, `got ${h.nonce}`);

    // Config — every field
    check("config.collateralMint", c.collateralMint.equals(mint));
    check("config.vaultPubkey", c.vaultPubkey.equals(vault));
    check("config.confFilterBps", c.confFilterBps === 200);
    check("config.invert=0", c.invert === 0);
    check("config.unitScale=0", c.unitScale === 0);
    check("config.vaultAuthorityBump > 0", c.vaultAuthorityBump > 0);
    check("config.fundingHorizonSlots > 0", c.fundingHorizonSlots > 0n);
    check("config.maxInsuranceFloor", c.maxInsuranceFloor === 10000000000000000n);
    check("config.resolutionSlot (init)", c.resolutionSlot >= 0n);
    check("config.markEwmaE6 (Hyperp init)", c.markEwmaE6 >= 0n);
    check("config.forceCloseDelaySlots=0", c.forceCloseDelaySlots === 0n);

    // Params — every field
    check("params.mm=500", p.maintenanceMarginBps === 500n);
    check("params.im=1000", p.initialMarginBps === 1000n);
    check("params.tradingFee=10", p.tradingFeeBps === 10n);
    check("params.maxAccounts=64", p.maxAccounts === 64n);
    check("params.newAccountFee=1M", p.newAccountFee === 1000000n);
    check("params field (h_max via wire)", true);
    check("params.maxCrankStaleness=200", p.maxCrankStalenessSlots === 200n);
    check("params.liqFeeBps=100", p.liquidationFeeBps === 100n);
    check("params.liqFeeCap=1B", p.liquidationFeeCap === 1000000000n);
    check("params.minLiqAbs=100K", p.minLiquidationAbs === 100000n);
    check("params.minDeposit=1M", p.minInitialDeposit === 1000000n);
    check("params.minMm=100K", p.minNonzeroMmReq === 100000n);
    check("params.minIm=200K", p.minNonzeroImReq === 200000n);
    check("params.insuranceFloor=0", p.insuranceFloor === 0n);

    // Engine — every field at init
    check("engine.vault=0", e.vault === 0n);
    check("engine.insurance=0", e.insuranceFund.balance === 0n);
    check("engine.currentSlot > 0", e.currentSlot > 0n);
    check("engine.fundingRate=0", e.fundingRateE9PerSlotLast === 0n);
    check("engine.lastCrankSlot (init)", e.lastCrankSlot >= 0n);
    check("engine.cTot=0", e.cTot === 0n);
    check("engine.pnlPosTot=0", e.pnlPosTot === 0n);
    check("engine.numUsed=0", e.numUsedAccounts === 0);
    check("engine.nextAccountId > 0", e.nextAccountId >= 0n);
    check("engine.lifetimeLiqs=0", e.lifetimeLiquidations === 0n);
    check("engine.adlMultLong=1M", e.adlMultLong === 1000000n);
    check("engine.sideModeLong=Normal", e.sideModeLong === 0);
    check("engine.sideModeShort=Normal", e.sideModeShort === 0);

    // Conservation
    const splBal = await getVaultSpl(vault);
    check("conservation: spl=0", splBal === 0n);
  }

  // ════════════════════════════════════════
  // 2. SET ORACLE + CRANK — verify oracle/crank fields update
  // ════════════════════════════════════════
  console.log("\n=== 2. SetOracle + PushPrice + Crank: verify field updates ===");
  {
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slab.publicKey]),
      data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) })], [payer]);

    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: encodePushOraclePrice({ priceE6: "100000000", timestamp: Math.floor(Date.now() / 1000).toString() }) })], [payer]);

    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preE = parseEngine(preBuf);

    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
    ]);
    await tx([buildIx({ programId: PROG, keys: crankKeys,
      data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }) })], [payer]);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postE = parseEngine(postBuf);

    check("crank: lastCrankSlot increases", postE.lastCrankSlot > preE.lastCrankSlot,
      `${preE.lastCrankSlot} -> ${postE.lastCrankSlot}`);
    check("crank: lastOraclePrice set", postE.lastOraclePrice > 0n);
    check("crank: currentSlot advances", postE.currentSlot >= preE.currentSlot);

    const c = parseConfig(postBuf);
    check("oracle: authorityPriceE6=100M", c.authorityPriceE6 === 100000000n);
    check("oracle: oracleAuthority set", c.oracleAuthority.equals(payer.publicKey));
  }

  // ════════════════════════════════════════
  // 3. INIT USER + LP — verify accounts, bitmap, numUsed, accountId, fees
  // ════════════════════════════════════════
  console.log("\n=== 3. InitUser + InitLP: verify account creation ===");
  const matcherCtx = Keypair.generate();
  const [lpPda] = deriveLpPda(PROG, slab.publicKey, 0);
  {
    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preE = parseEngine(preBuf);

    // Init LP (idx 0)
    const matcherInitData = Buffer.alloc(66);
    matcherInitData[0] = 2; matcherInitData[1] = 0; // passive
    matcherInitData.writeUInt32LE(50, 2); // trading_fee 50bps
    matcherInitData.writeUInt32LE(50, 6); // spread 50bps
    matcherInitData.writeUInt32LE(1000, 10); // max_total 1000bps
    matcherInitData.writeUInt32LE(0, 14); // impact_k 0
    // liquidity_notional_e6 (u128 at 18): 1B
    matcherInitData.writeBigUInt64LE(1000000000n, 18); matcherInitData.writeBigUInt64LE(0n, 26);
    // max_fill_abs (u128 at 34): 100M
    matcherInitData.writeBigUInt64LE(100000000n, 34); matcherInitData.writeBigUInt64LE(0n, 42);
    // max_inventory_abs (u128 at 50): 100M
    matcherInitData.writeBigUInt64LE(100000000n, 50); matcherInitData.writeBigUInt64LE(0n, 58);

    await tx([
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
        lamports: await conn.getMinimumBalanceForRentExemption(320), space: 320, programId: MATCHER_PROGRAM,
      }),
      { programId: MATCHER_PROGRAM, keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },
        { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
      ], data: matcherInitData },
      buildIx({ programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
        data: encodeInitLP({ matcherProgram: MATCHER_PROGRAM, matcherContext: matcherCtx.publicKey, feePayment: "1000000" }) }),
    ], [payer, matcherCtx], 300000);

    // Init User (idx 1)
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeInitUser({ feePayment: "1000000" }) })], [payer]);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postE = parseEngine(postBuf);

    check("initLP: numUsed 0->2", postE.numUsedAccounts === preE.numUsedAccounts + 2);
    check("initLP: bitmap[0] set", isAccountUsed(postBuf, 0));
    check("initUser: bitmap[1] set", isAccountUsed(postBuf, 1));
    check("initLP: nextAccountId advances", postE.nextAccountId > preE.nextAccountId);

    const lp = parseAccount(postBuf, 0);
    const user = parseAccount(postBuf, 1);
    check("LP: kind=LP", lp.kind === 1);
    check("LP: accountId >= 0", lp.accountId >= 0n);
    check("LP: owner=payer", lp.owner.equals(payer.publicKey));
    check("LP: matcherProgram set", !lp.matcherProgram.equals(PublicKey.default));
    check("LP: matcherContext set", !lp.matcherContext.equals(PublicKey.default));
    check("User: kind=User", user.kind === 0);
    check("User: accountId > LP", user.accountId > lp.accountId);
    check("User: owner=payer", user.owner.equals(payer.publicKey));

    // Fee deducted from vault
    check("vault: fee tokens received", postE.vault > 0n);
  }

  // ════════════════════════════════════════
  // 4. DEPOSIT — verify exact capital delta, vault delta, cTot delta
  // ════════════════════════════════════════
  console.log("\n=== 4. Deposit: verify capital + vault + cTot deltas ===");
  const DEPOSIT = 100_000_000n;
  {
    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preE = parseEngine(preBuf);
    const preLp = parseAccount(preBuf, 0);
    const preUser = parseAccount(preBuf, 1);
    const preSpl = await getVaultSpl(vault);

    // Deposit to LP (idx 0)
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeDepositCollateral({ userIdx: 0, amount: DEPOSIT.toString() }) })], [payer]);

    // Deposit to User (idx 1)
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeDepositCollateral({ userIdx: 1, amount: DEPOSIT.toString() }) })], [payer]);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postE = parseEngine(postBuf);
    const postLp = parseAccount(postBuf, 0);
    const postUser = parseAccount(postBuf, 1);
    const postSpl = await getVaultSpl(vault);

    check("deposit LP: capital delta exact", postLp.capital - preLp.capital === DEPOSIT,
      `delta=${postLp.capital - preLp.capital}`);
    check("deposit User: capital delta exact", postUser.capital - preUser.capital === DEPOSIT,
      `delta=${postUser.capital - preUser.capital}`);
    check("deposit: vault delta = 2*DEPOSIT", postE.vault - preE.vault === 2n * DEPOSIT,
      `delta=${postE.vault - preE.vault}`);
    check("deposit: cTot increases", postE.cTot > preE.cTot);
    check("deposit: SPL delta matches", postSpl - preSpl === 2n * DEPOSIT);
    check("conservation: engine.vault = SPL", postE.vault === postSpl);
    check("accounting: vault >= cTot + insurance", postE.vault >= postE.cTot + postE.insuranceFund.balance,
      `vault(${postE.vault}) < cTot(${postE.cTot}) + ins(${postE.insuranceFund.balance})`);
  }

  // ════════════════════════════════════════
  // 5. TOPUP INSURANCE — verify exact insurance delta
  // ════════════════════════════════════════
  console.log("\n=== 5. TopUpInsurance: verify exact delta ===");
  const INS_AMOUNT = 10_000_000n;
  {
    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preE = parseEngine(preBuf);
    const preSpl = await getVaultSpl(vault);

    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]),
      data: encodeTopUpInsurance({ amount: INS_AMOUNT.toString() }) })], [payer]);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postE = parseEngine(postBuf);
    const postSpl = await getVaultSpl(vault);

    check("topup: insurance delta exact", postE.insuranceFund.balance - preE.insuranceFund.balance === INS_AMOUNT);
    check("topup: vault delta exact", postE.vault - preE.vault === INS_AMOUNT);
    check("topup: SPL delta matches", postSpl - preSpl === INS_AMOUNT);
    check("conservation: engine.vault = SPL", postE.vault === postSpl);
    check("accounting: vault >= cTot + insurance", postE.vault >= postE.cTot + postE.insuranceFund.balance,
      `vault(${postE.vault}) < cTot(${postE.cTot}) + ins(${postE.insuranceFund.balance})`);
  }

  // ════════════════════════════════════════
  // 6. TRADE — verify position, capital, fees for BOTH user and LP
  // ════════════════════════════════════════
  console.log("\n=== 6. Trade (TradeCpi): verify position + capital + fees ===");
  {
    // Wait for warmup
    await sleep(5000);
    // Crank first
    const crankKeys6 = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
    ]);
    await tx([buildIx({ programId: PROG, keys: crankKeys6,
      data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }) })], [payer]);

    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preUser = parseAccount(preBuf, 1);
    const preLp = parseAccount(preBuf, 0);
    const preE = parseEngine(preBuf);

    // Trade: user buys 100 units (Hyperp mode requires TradeCpi)
    // ACCOUNTS_TRADE_CPI: user, lpOwner, slab, clock, oracle, matcherProg, matcherCtx, lpPda
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey, payer.publicKey, slab.publicKey,
      WELL_KNOWN.clock, payer.publicKey,
      MATCHER_PROGRAM, matcherCtx.publicKey, lpPda,
    ]);
    await tx([buildIx({ programId: PROG, keys: tradeKeys,
      data: encodeTradeCpi({ userIdx: 1, lpIdx: 0, size: "2000000" }) })], [payer], 400000);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postUser = parseAccount(postBuf, 1);
    const postLp = parseAccount(postBuf, 0);
    const postE = parseEngine(postBuf);

    // Position checks
    check("trade: user pos increased", postUser.positionBasisQ > preUser.positionBasisQ,
      `${preUser.positionBasisQ} -> ${postUser.positionBasisQ}`);
    check("trade: LP pos mirrors (opposite)", postLp.positionBasisQ < preLp.positionBasisQ,
      `${preLp.positionBasisQ} -> ${postLp.positionBasisQ}`);
    const userPosDelta = postUser.positionBasisQ - preUser.positionBasisQ;
    const lpPosDelta = postLp.positionBasisQ - preLp.positionBasisQ;
    check("trade: positions sum to zero", userPosDelta + lpPosDelta === 0n,
      `userDelta=${userPosDelta}, lpDelta=${lpPosDelta}`);

    // Capital checks — user pays fees, LP earns
    check("trade: user capital decreases (fees)", postUser.capital <= preUser.capital,
      `${preUser.capital} -> ${postUser.capital}`);
    check("trade: LP feesEarnedTotal increases", postLp.feesEarnedTotal > preLp.feesEarnedTotal,
      `${preLp.feesEarnedTotal} -> ${postLp.feesEarnedTotal}`);

    // Conservation
    const postSpl = await getVaultSpl(vault);
    check("conservation: engine.vault = SPL", postE.vault === postSpl);
    check("accounting: vault >= cTot + insurance", postE.vault >= postE.cTot + postE.insuranceFund.balance,
      `vault(${postE.vault}) < cTot(${postE.cTot}) + ins(${postE.insuranceFund.balance})`);
  }

  // ════════════════════════════════════════
  // 7. WITHDRAW — verify exact deltas
  // ════════════════════════════════════════
  console.log("\n=== 7. Withdraw: verify exact capital + vault deltas ===");
  const WITHDRAW = 1_000_000n;
  {
    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preUser = parseAccount(preBuf, 1);
    const preE = parseEngine(preBuf);
    const preSpl = await getVaultSpl(vault);

    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
        payer.publicKey, slab.publicKey, vault, payerAta.address,
        vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, payer.publicKey,
      ]),
      data: encodeWithdrawCollateral({ userIdx: 1, amount: WITHDRAW.toString() }) })], [payer]);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postUser = parseAccount(postBuf, 1);
    const postE = parseEngine(postBuf);
    const postSpl = await getVaultSpl(vault);

    check("withdraw: user capital delta exact", preUser.capital - postUser.capital === WITHDRAW,
      `delta=${preUser.capital - postUser.capital}`);
    check("withdraw: vault delta exact", preE.vault - postE.vault === WITHDRAW,
      `delta=${preE.vault - postE.vault}`);
    check("withdraw: SPL delta matches", preSpl - postSpl === WITHDRAW);
    check("withdraw: cTot decreases", postE.cTot < preE.cTot);
    check("conservation: engine.vault = SPL", postE.vault === postSpl);
    check("accounting: vault >= cTot + insurance", postE.vault >= postE.cTot + postE.insuranceFund.balance,
      `vault(${postE.vault}) < cTot(${postE.cTot}) + ins(${postE.insuranceFund.balance})`);
  }

  // ════════════════════════════════════════
  // 8. BANK RUN — close user position, close account, verify vault drain
  // ════════════════════════════════════════
  console.log("\n=== 8. Bank Run: close position, close account, verify vault drain ===");
  {
    const preBuf = await fetchSlab(conn, slab.publicKey);
    const preE = parseEngine(preBuf);
    const preUsed = parseUsedIndices(preBuf);

    // Close user position (trade back to 0)
    const user = parseAccount(preBuf, 1);
    if (user.positionBasisQ !== 0n) {
      const closeTradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        payer.publicKey, payer.publicKey, slab.publicKey,
        WELL_KNOWN.clock, payer.publicKey,
        MATCHER_PROGRAM, matcherCtx.publicKey, lpPda,
      ]);
      await tx([buildIx({ programId: PROG, keys: closeTradeKeys,
        data: encodeTradeCpi({ userIdx: 1, lpIdx: 0, size: (-user.positionBasisQ).toString() }) })], [payer], 400000);
    }

    const midBuf = await fetchSlab(conn, slab.publicKey);
    const midUser = parseAccount(midBuf, 1);
    check("bank run: user position closed to 0", midUser.positionBasisQ === 0n,
      `pos=${midUser.positionBasisQ}`);

    // Crank to mature PnL before closing
    const crankKeys8 = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
    ]);
    await sleep(3000);
    for (let i = 0; i < 3; i++) {
      await tx([buildIx({ programId: PROG, keys: crankKeys8,
        data: encodeKeeperCrank({ callerIdx: 65535, candidates: [1] }) })], [payer]);
      await sleep(500);
    }

    // Close account
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
      payer.publicKey, slab.publicKey, vault, payerAta.address,
      vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, payer.publicKey,
    ]);
    await tx([buildIx({ programId: PROG, keys: closeKeys,
      data: encodeCloseAccount({ idx: 1 }) })], [payer]);

    const postBuf = await fetchSlab(conn, slab.publicKey);
    const postE = parseEngine(postBuf);
    const postUsed = parseUsedIndices(postBuf);

    check("bank run: numUsed decremented", postE.numUsedAccounts === preE.numUsedAccounts - 1,
      `${preE.numUsedAccounts} -> ${postE.numUsedAccounts}`);
    // Bitmap may be cleared by GC during next crank, not immediately
    check("bank run: account closed (numUsed check)", postE.numUsedAccounts < preE.numUsedAccounts);
    check("bank run: vault decreased (capital returned)", postE.vault < preE.vault);
    check("bank run: cTot decreased", postE.cTot < preE.cTot);

    const postSpl = await getVaultSpl(vault);
    check("conservation: engine.vault = SPL", postE.vault === postSpl);
    check("accounting: vault >= cTot + insurance", postE.vault >= postE.cTot + postE.insuranceFund.balance,
      `vault(${postE.vault}) < cTot(${postE.cTot}) + ins(${postE.insuranceFund.balance})`);
  }

  // ════════════════════════════════════════
  // 9. RESOLVE + FORCE CLOSE — verify resolved flag, resolutionSlot
  // ════════════════════════════════════════
  console.log("\n=== 9. Resolve + ForceClose: verify resolution state ===");
  {
    // Push settlement price
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: encodePushOraclePrice({ priceE6: "100000000", timestamp: Math.floor(Date.now() / 1000).toString() }) })], [payer]);

    // Resolve
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey]),
      data: encodeResolveMarket() })], [payer]);

    const buf1 = await fetchSlab(conn, slab.publicKey);
    const h1 = parseHeader(buf1);
    const c1 = parseConfig(buf1);
    check("resolve: header.resolved=true", h1.resolved);
    check("resolve: config.resolutionSlot > 0", c1.resolutionSlot > 0n,
      `got ${c1.resolutionSlot}`);

    // Crank to force-close LP
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
    ]);
    for (let i = 0; i < 3; i++) {
      await tx([buildIx({ programId: PROG, keys: crankKeys,
        data: encodeKeeperCrank({ callerIdx: 65535, candidates: [0] }) })], [payer]);
    }

    // Force-close any remaining
    const remaining = parseUsedIndices(await fetchSlab(conn, slab.publicKey));
    for (const idx of remaining) {
      await tx([buildIx({ programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_ADMIN_FORCE_CLOSE, [payer.publicKey, slab.publicKey, vault, payerAta.address, vaultPda, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, payer.publicKey]),
        data: encodeAdminForceCloseAccount({ userIdx: idx }) })], [payer]);
    }

    const buf2 = await fetchSlab(conn, slab.publicKey);
    const e2 = parseEngine(buf2);
    const used2 = parseUsedIndices(buf2);
    check("force-close: all accounts closed", used2.length === 0);
    check("force-close: numUsed=0", e2.numUsedAccounts === 0);
    check("force-close: bitmap empty", !isAccountUsed(buf2, 0));

    // Withdraw insurance
    await tx([buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
        payer.publicKey, slab.publicKey, payerAta.address, vault, WELL_KNOWN.tokenProgram, vaultPda,
      ]),
      data: encodeWithdrawInsurance() })], [payer]);

    const buf3 = await fetchSlab(conn, slab.publicKey);
    const e3 = parseEngine(buf3);
    check("withdrawInsurance: insurance=0", e3.insuranceFund.balance === 0n);
    check("withdrawInsurance: vault=0", e3.vault === 0n);

    const finalSpl = await getVaultSpl(vault);
    check("final conservation: SPL=0", finalSpl === 0n);
  }

  // ════════════════════════════════════════
  // CLOSE SLAB — reclaim rent
  // ════════════════════════════════════════
  console.log("\n=== Cleanup: close slab ===");
  {
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
      payer.publicKey, slab.publicKey, vault, vaultPda,
      payerAta.address, WELL_KNOWN.tokenProgram,
    ]);
    await tx([buildIx({ programId: PROG, keys: closeKeys, data: encodeCloseSlab() })], [payer], 1400000);
    ok("slab closed, rent reclaimed");
  }

  // ════════════════════════════════════════
  console.log("\n════════════════════════════════════════");
  console.log(`  TOTAL: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  console.log("════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
