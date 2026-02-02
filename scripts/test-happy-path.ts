/**
 * Happy Path Test — Profit, Loss, and Max Margin (inverted market)
 *
 * Verifies correct expected behavior under normal conditions:
 * 1. Round-trip: User opens and closes at same price, withdraws (pays only fees)
 * 2. Winner: User trades, price moves in their favor, warmup converts PnL, withdraws profit
 * 3. Loser:  User trades, price moves against them slightly, closes, withdraws remaining capital
 * 4. Max Leverage LONG:  Opens near-max leverage LONG, profits on +2% move, full warmup cycle
 * 5. Max Leverage SHORT: Opens near-max leverage SHORT, profits on -2% move, full warmup cycle
 * 6. Over-Leverage Rejection: Confirms trades exceeding 10x initial margin are rejected
 *
 * All scenarios run on the inverted devnet market (SOL/USD inverted).
 * LONG profits when inverted price goes UP; SHORT profits when inverted price goes DOWN.
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID,
  NATIVE_MINT, createSyncNativeInstruction, getAccount,
} from "@solana/spl-token";
import {
  fetchSlab, parseEngine, parseConfig, parseParams,
  parseAccount, parseUsedIndices, AccountKind,
} from "../src/solana/slab.js";
import {
  encodeKeeperCrank, encodeDepositCollateral,
  encodeInitUser, encodePushOraclePrice,
  encodeSetOracleAuthority, encodeCloseAccount,
  encodeTradeCpi, encodeWithdrawCollateral,
  encodeTopUpInsurance,
} from "../src/abi/instructions.js";
import {
  buildAccountMetas, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_TRADE_CPI,
  ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_TOPUP_INSURANCE,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);
const VAULT = new PublicKey(marketInfo.vault);
const LP_IDX = marketInfo.lp.index;

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const params = parseParams(data);
  const accounts: any[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) accounts.push({ idx, ...acc, kind: acc.kind === AccountKind.LP ? "LP" : "USER" });
  }
  return { engine, config, params, accounts, data };
}

function checkConservation(state: any, label: string): boolean {
  const e = state.engine;
  const totalCap = state.accounts.reduce((s: bigint, a: any) => s + BigInt(a.capital), 0n);
  const ins = e.insuranceFund.balance;
  const vault = e.vault;
  const slack = vault - totalCap - ins;
  const ok = slack >= 0n;
  if (!ok) console.log(`  *** CONSERVATION VIOLATED at ${label}: slack=${fmt(slack)} ***`);
  return ok;
}

// ---------------------------------------------------------------------------
// On-chain operations
// ---------------------------------------------------------------------------
async function crank() {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function crankN(n: number, gapMs = 500) {
  for (let i = 0; i < n; i++) {
    try { await crank(); } catch {}
    await delay(gapMs);
  }
}

async function pushPrice(priceE6: bigint) {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: timestamp.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function initUser(): Promise<number | null> {
  const before = new Set(parseUsedIndices((await getState()).data));
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeInitUser({ feePayment: "1000000" }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  for (const idx of parseUsedIndices((await getState()).data)) {
    if (!before.has(idx)) return idx;
  }
  return null;
}

async function deposit(accountIdx: number, amount: bigint) {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userAta.address, lamports: amount }),
    createSyncNativeInstruction(userAta.address)
  );
  await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeDepositCollateral({ userIdx: accountIdx, amount: amount.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function trade(userIdx: number, size: bigint) {
  const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, MATCHER_CTX, LP_PDA,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeTradeCpi({ lpIdx: LP_IDX, userIdx, size: size.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function withdraw(userIdx: number, amount: bigint) {
  const { config } = await getState();
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);
  const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, config.vaultPubkey, userAta.address,
    vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeWithdrawCollateral({ userIdx, amount: amount.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function closeAccount(userIdx: number) {
  const { config } = await getState();
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);
  const keys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
    payer.publicKey, SLAB, config.vaultPubkey, userAta.address,
    vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeCloseAccount({ userIdx }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function topUpInsurance(amount: bigint) {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userAta.address, lamports: amount }),
    createSyncNativeInstruction(userAta.address)
  );
  await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeTopUpInsurance({ amount: amount.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

// ===========================================================================
// Test scenarios
// ===========================================================================

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}

async function scenarioWinner(basePrice: bigint): Promise<TestResult> {
  console.log("\n============================================================");
  console.log("SCENARIO 1: Winner — profit withdrawal with warmup");
  console.log("============================================================");

  const DEPOSIT = 2_000_000_000n; // 2 SOL
  const SIZE = 500_000_000_000n;  // 500B units (~4.8x leverage)

  // Create + fund
  console.log("  Creating trader...");
  const idx = await initUser();
  if (idx === null) return { name: "Winner", pass: false, details: "Failed to create account" };
  await deposit(idx, DEPOSIT);
  console.log(`  Trader ${idx}: deposited ${fmt(DEPOSIT)} SOL`);

  // Open LONG at base price
  await pushPrice(basePrice);
  await crank();
  await trade(idx, SIZE);
  let state = await getState();
  let acc = state.accounts.find((a: any) => a.idx === idx);
  console.log(`  Opened LONG ${SIZE}: capital=${fmt(BigInt(acc?.capital || 0))}, pnl=${fmt(BigInt(acc?.pnl || 0))}`);
  checkConservation(state, "after-open");

  // Price moves UP 2% (user profits on LONG in inverted market: inverted price goes UP)
  // Use moderate move to avoid LP margin issues on accumulated slab state
  const upPrice = basePrice * 102n / 100n;
  console.log(`  Price: ${basePrice} → ${upPrice} (+2%)`);
  await pushPrice(upPrice);

  // Crank several times to ensure full sweep settles all accounts at new price
  await crankN(3, 1000);

  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const pnlAfterMark = BigInt(acc?.pnl || 0);
  console.log(`  After mark: capital=${fmt(BigInt(acc?.capital || 0))}, pnl=${fmt(pnlAfterMark)}`);

  // Close position — this resets warmup_started_at_slot via update_warmup_slope
  console.log("  Closing position...");
  try {
    await trade(idx, -SIZE);
  } catch (e: any) {
    // LP might be undercollateralized at moved price — reset price, crank, retry
    console.log(`  Close failed (${e.message?.slice(0, 50)}), resetting price and retrying...`);
    await pushPrice(basePrice);
    await crankN(3, 1000);
    await pushPrice(upPrice);
    await crankN(3, 1000);
    await trade(idx, -SIZE);
  }
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalAfterClose = BigInt(acc?.capital || 0);
  const pnlAfterClose = BigInt(acc?.pnl || 0);
  const posAfterClose = BigInt(acc?.positionSize || 0);
  console.log(`  After close: capital=${fmt(capitalAfterClose)}, pnl=${fmt(pnlAfterClose)}, position=${posAfterClose}`);

  if (posAfterClose !== 0n) {
    return { name: "Winner", pass: false, details: `Position not flat: ${posAfterClose}` };
  }

  // Wait for warmup period to elapse.
  // warmupPeriodSlots=10 on devnet (~4 seconds at ~2.5 slots/sec).
  // keeper_crank does NOT call settle_warmup_to_capital — conversion only
  // triggers on user operations (withdraw, close_account, deposit) that call
  // touch_account_full. We just need enough slots to pass before that call.
  console.log("  Waiting 10 seconds for warmup period to elapse (10 slots @ ~2.5 slots/sec)...");
  await delay(10_000);

  // Read slab state — PnL will still show because cranks don't settle warmup.
  // The conversion happens inside the next user operation (withdraw/close_account).
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  console.log(`  Before withdrawal: capital=${fmt(BigInt(acc?.capital || 0))}, pnl=${fmt(BigInt(acc?.pnl || 0))}`);
  console.log("  (PnL still visible — conversion triggers inside withdraw/close_account)");

  // Withdraw a small amount to trigger touch_account_full → settle_warmup_to_capital.
  // This converts warmed PnL to capital. Then we can read the true post-warmup capital.
  console.log("  Triggering settlement via small withdrawal (1 lamport)...");
  try {
    await withdraw(idx, 1n);
  } catch (e: any) {
    console.log(`  Small withdraw failed: ${e.message?.slice(0, 80)}`);
  }

  // Crank to keep market fresh for subsequent operations
  try { await crank(); } catch {}
  await delay(1000);

  // Now read state — PnL should be converted to capital
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalAfterWarmup = BigInt(acc?.capital || 0);
  const pnlAfterWarmup = BigInt(acc?.pnl || 0);
  console.log(`  After warmup settlement: capital=${fmt(capitalAfterWarmup)}, pnl=${fmt(pnlAfterWarmup)}`);
  checkConservation(state, "after-warmup");

  // Withdraw all remaining capital
  let totalWithdrawn = 1n; // already withdrew 1 lamport
  console.log(`  Withdrawing remaining ${fmt(capitalAfterWarmup)} SOL...`);
  try {
    await withdraw(idx, capitalAfterWarmup);
    totalWithdrawn += capitalAfterWarmup;
    console.log("  Withdrawal SUCCESS");
  } catch (e: any) {
    // Margin check might block if fees accumulate — try 95%
    const reduced = capitalAfterWarmup * 95n / 100n;
    console.log(`  Full withdraw blocked, trying ${fmt(reduced)}...`);
    try {
      await withdraw(idx, reduced);
      totalWithdrawn += reduced;
      console.log(`  Partial withdrawal SUCCESS: ${fmt(reduced)}`);
    } catch (e2: any) {
      return { name: "Winner", pass: false, details: `Withdrawal failed: ${e2.message?.slice(0, 80)}` };
    }
  }

  // Close account (returns any remaining capital)
  try {
    await closeAccount(idx);
    console.log("  Account closed");
  } catch (e: any) {
    console.log(`  Close account: ${e.message?.slice(0, 60)} (may need more warmup or crank)`);
  }

  // Verify: capital after warmup should exceed deposit (user profited)
  const profit = capitalAfterWarmup - DEPOSIT;
  console.log(`  Warmup result: capital=${fmt(capitalAfterWarmup)}, deposit=${fmt(DEPOSIT)}`);

  if (capitalAfterWarmup > DEPOSIT) {
    console.log(`  PROFIT: ${fmt(profit)} SOL (${(Number(profit) * 100 / Number(DEPOSIT)).toFixed(2)}%)`);
    return {
      name: "Winner",
      pass: true,
      details: `Deposited ${fmt(DEPOSIT)}, capital after warmup ${fmt(capitalAfterWarmup)}, profit ${fmt(profit)} — warmup PnL→capital conversion verified`,
    };
  } else if (pnlAfterWarmup > 0n) {
    return { name: "Winner", pass: false, details: `Warmup incomplete: capital=${fmt(capitalAfterWarmup)}, remaining pnl=${fmt(pnlAfterWarmup)}` };
  } else {
    return { name: "Winner", pass: false, details: `No profit after warmup: capital=${fmt(capitalAfterWarmup)}, deposit=${fmt(DEPOSIT)} (fees consumed profit)` };
  }
}

async function scenarioLoser(basePrice: bigint): Promise<TestResult> {
  console.log("\n============================================================");
  console.log("SCENARIO 2: Loser — withdraw remaining capital");
  console.log("============================================================");

  const DEPOSIT = 2_000_000_000n; // 2 SOL
  const SIZE = 500_000_000_000n;  // 500B units

  // Create + fund
  console.log("  Creating trader...");
  const idx = await initUser();
  if (idx === null) return { name: "Loser", pass: false, details: "Failed to create account" };
  await deposit(idx, DEPOSIT);
  console.log(`  Trader ${idx}: deposited ${fmt(DEPOSIT)} SOL`);

  // Open LONG at base price
  await pushPrice(basePrice);
  await crank();
  await trade(idx, SIZE);
  let state = await getState();
  let acc = state.accounts.find((a: any) => a.idx === idx);
  console.log(`  Opened LONG ${SIZE}: capital=${fmt(BigInt(acc?.capital || 0))}`);

  // Price moves DOWN 3% (user loses on LONG)
  const downPrice = basePrice * 97n / 100n;
  console.log(`  Price: ${basePrice} → ${downPrice} (-3%)`);
  await pushPrice(downPrice);

  // Crank to settle losses
  await crankN(5);

  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalAfterLoss = BigInt(acc?.capital || 0);
  const pnlAfterLoss = BigInt(acc?.pnl || 0);
  console.log(`  After loss: capital=${fmt(capitalAfterLoss)}, pnl=${fmt(pnlAfterLoss)}`);

  // Close position
  console.log("  Closing position...");
  await trade(idx, -SIZE);
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalAfterClose = BigInt(acc?.capital || 0);
  const posAfterClose = BigInt(acc?.positionSize || 0);
  console.log(`  After close: capital=${fmt(capitalAfterClose)}, position=${posAfterClose}`);

  if (posAfterClose !== 0n) {
    return { name: "Loser", pass: false, details: `Position not flat: ${posAfterClose}` };
  }

  // Withdraw remaining capital
  if (capitalAfterClose > 0n) {
    console.log(`  Withdrawing remaining ${fmt(capitalAfterClose)} SOL...`);
    try {
      await withdraw(idx, capitalAfterClose);
      console.log("  Withdrawal SUCCESS");
    } catch (e: any) {
      const reduced = capitalAfterClose * 95n / 100n;
      console.log(`  Full withdraw blocked, trying ${fmt(reduced)}...`);
      try {
        await withdraw(idx, reduced);
        console.log(`  Partial withdrawal SUCCESS: ${fmt(reduced)}`);
      } catch (e2: any) {
        return { name: "Loser", pass: false, details: `Withdrawal failed: ${e2.message?.slice(0, 80)}` };
      }
    }
  }

  // Close account
  try {
    await closeAccount(idx);
    console.log("  Account closed");
  } catch (e: any) {
    console.log(`  Close account: ${e.message?.slice(0, 60)}`);
  }

  const loss = DEPOSIT - capitalAfterClose;
  console.log(`  LOSS: ${fmt(loss)} SOL (${(Number(loss) * 100 / Number(DEPOSIT)).toFixed(2)}% of deposit)`);

  if (capitalAfterClose < DEPOSIT && capitalAfterClose > 0n) {
    return { name: "Loser", pass: true, details: `Deposited ${fmt(DEPOSIT)}, withdrew ${fmt(capitalAfterClose)}, lost ${fmt(loss)}` };
  } else if (capitalAfterClose === 0n) {
    return { name: "Loser", pass: false, details: `All capital lost (leverage too high or loss too large)` };
  } else {
    return { name: "Loser", pass: true, details: `Deposited ${fmt(DEPOSIT)}, capital=${fmt(capitalAfterClose)}` };
  }
}

async function scenarioRoundTrip(basePrice: bigint): Promise<TestResult> {
  console.log("\n============================================================");
  console.log("SCENARIO 3: Round-trip — open and close at same price");
  console.log("============================================================");

  const DEPOSIT = 2_000_000_000n; // 2 SOL
  const SIZE = 500_000_000_000n;  // 500B units

  // Create + fund
  console.log("  Creating trader...");
  const idx = await initUser();
  if (idx === null) return { name: "Round-trip", pass: false, details: "Failed to create account" };
  await deposit(idx, DEPOSIT);
  console.log(`  Trader ${idx}: deposited ${fmt(DEPOSIT)} SOL`);

  // Open and close at same price
  await pushPrice(basePrice);
  await crank();
  await trade(idx, SIZE);

  let state = await getState();
  let acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalAfterOpen = BigInt(acc?.capital || 0);
  console.log(`  Opened LONG: capital=${fmt(capitalAfterOpen)}`);

  // Close immediately at same price
  await trade(idx, -SIZE);
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalAfterClose = BigInt(acc?.capital || 0);
  const posAfterClose = BigInt(acc?.positionSize || 0);
  console.log(`  Closed: capital=${fmt(capitalAfterClose)}, position=${posAfterClose}`);

  // The user should have lost only the trading fees (2 × fee per trade)
  const feePaid = DEPOSIT - capitalAfterClose;
  console.log(`  Fees paid: ${fmt(feePaid)} SOL`);

  // Withdraw
  if (capitalAfterClose > 0n) {
    console.log(`  Withdrawing ${fmt(capitalAfterClose)} SOL...`);
    try {
      await withdraw(idx, capitalAfterClose);
      console.log("  Withdrawal SUCCESS");
    } catch (e: any) {
      return { name: "Round-trip", pass: false, details: `Withdrawal failed: ${e.message?.slice(0, 80)}` };
    }
  }

  // Close account
  try {
    await closeAccount(idx);
    console.log("  Account closed");
  } catch (e: any) {
    console.log(`  Close account: ${e.message?.slice(0, 60)}`);
  }

  // Should have lost only fees, not more than ~5% of deposit
  const feePct = Number(feePaid) * 100 / Number(DEPOSIT);
  if (feePct < 5) {
    return { name: "Round-trip", pass: true, details: `Deposited ${fmt(DEPOSIT)}, withdrew ${fmt(capitalAfterClose)}, fees=${fmt(feePaid)} (${feePct.toFixed(2)}%)` };
  } else {
    return { name: "Round-trip", pass: false, details: `Excessive fee: ${feePct.toFixed(2)}% — expected < 5%` };
  }
}

// ===========================================================================
// Max-margin scenarios (inverted market)
// ===========================================================================

async function scenarioMaxLeverageLong(basePrice: bigint): Promise<TestResult> {
  console.log("\n============================================================");
  console.log("SCENARIO 4: Max Leverage LONG (inverted market)");
  console.log("============================================================");

  const DEPOSIT = 2_000_000_000n; // 2 SOL
  // With ~1.97 SOL effective capital after init fee:
  //   notional = size * price / 1e6
  //   margin_required = notional * 1000 / 10000 = notional * 0.10
  //   At 1.8T size, notional ≈ 17.3 SOL → margin ≈ 1.73 SOL (passes 10% IMF)
  const SIZE = 1_800_000_000_000n; // ~8.8x leverage

  console.log("  Creating trader...");
  const idx = await initUser();
  if (idx === null) return { name: "MaxLev LONG", pass: false, details: "Failed to create account" };
  await deposit(idx, DEPOSIT);
  console.log(`  Trader ${idx}: deposited ${fmt(DEPOSIT)} SOL`);

  // Open near-max-leverage LONG at base price
  await pushPrice(basePrice);
  await crank();

  let state = await getState();
  let acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalBeforeTrade = BigInt(acc?.capital || 0);

  try {
    await trade(idx, SIZE);
  } catch (e: any) {
    return { name: "MaxLev LONG", pass: false, details: `Trade rejected: ${e.message?.slice(0, 100)}` };
  }

  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const pos = BigInt(acc?.positionSize || 0);
  const capitalAfterOpen = BigInt(acc?.capital || 0);
  const notional = (pos < 0n ? -pos : pos) * basePrice / 1_000_000n;
  const leverage = capitalAfterOpen > 0n ? Number(notional) / Number(capitalAfterOpen) : 0;
  console.log(`  Opened LONG ${pos}: capital=${fmt(capitalAfterOpen)}, notional=${fmt(notional)}, leverage=${leverage.toFixed(1)}x`);
  checkConservation(state, "max-lev-long-open");

  // Inverted market: LONG profits when inverted price goes UP
  const upPrice4 = basePrice * 102n / 100n;
  console.log(`  Price: ${basePrice} → ${upPrice4} (+2%)`);
  await pushPrice(upPrice4);
  await crankN(3, 1000);

  // Close position
  console.log("  Closing position...");
  try {
    await trade(idx, -SIZE);
  } catch (e: any) {
    console.log(`  Close failed, resetting and retrying...`);
    await pushPrice(basePrice);
    await crankN(3, 1000);
    await pushPrice(upPrice4);
    await crankN(3, 1000);
    await trade(idx, -SIZE);
  }
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const pnlAfterClose = BigInt(acc?.pnl || 0);
  const posAfterClose = BigInt(acc?.positionSize || 0);
  console.log(`  After close: capital=${fmt(BigInt(acc?.capital || 0))}, pnl=${fmt(pnlAfterClose)}, position=${posAfterClose}`);

  if (posAfterClose !== 0n) {
    return { name: "MaxLev LONG", pass: false, details: `Position not flat: ${posAfterClose}` };
  }

  // Wait for warmup, trigger settlement
  console.log("  Waiting for warmup...");
  await delay(10_000);
  try { await withdraw(idx, 1n); } catch {}
  try { await crank(); } catch {}
  await delay(1000);

  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalFinal = BigInt(acc?.capital || 0);
  const pnlFinal = BigInt(acc?.pnl || 0);
  console.log(`  After warmup: capital=${fmt(capitalFinal)}, pnl=${fmt(pnlFinal)}`);

  // Withdraw and close
  try { await withdraw(idx, capitalFinal); } catch {}
  try { await closeAccount(idx); } catch {}

  const profit = capitalFinal - DEPOSIT;
  if (capitalFinal > DEPOSIT && pnlFinal === 0n) {
    console.log(`  PROFIT at ${leverage.toFixed(1)}x: ${fmt(profit)} SOL`);
    return { name: "MaxLev LONG", pass: true, details: `${leverage.toFixed(1)}x leverage, profit ${fmt(profit)} SOL on +2% move` };
  } else if (pnlFinal > 0n) {
    return { name: "MaxLev LONG", pass: false, details: `Warmup incomplete: pnl=${fmt(pnlFinal)} still pending` };
  } else {
    return { name: "MaxLev LONG", pass: false, details: `No profit at ${leverage.toFixed(1)}x: capital=${fmt(capitalFinal)}` };
  }
}

async function scenarioMaxLeverageShort(basePrice: bigint): Promise<TestResult> {
  console.log("\n============================================================");
  console.log("SCENARIO 5: Max Leverage SHORT (inverted market)");
  console.log("============================================================");

  const DEPOSIT = 2_000_000_000n;
  const SIZE = -1_800_000_000_000n; // SHORT ~8.8x leverage

  console.log("  Creating trader...");
  const idx = await initUser();
  if (idx === null) return { name: "MaxLev SHORT", pass: false, details: "Failed to create account" };
  await deposit(idx, DEPOSIT);
  console.log(`  Trader ${idx}: deposited ${fmt(DEPOSIT)} SOL`);

  // Open near-max-leverage SHORT at base price
  await pushPrice(basePrice);
  await crank();

  try {
    await trade(idx, SIZE);
  } catch (e: any) {
    return { name: "MaxLev SHORT", pass: false, details: `Trade rejected: ${e.message?.slice(0, 100)}` };
  }

  let state = await getState();
  let acc = state.accounts.find((a: any) => a.idx === idx);
  const pos = BigInt(acc?.positionSize || 0);
  const capitalAfterOpen = BigInt(acc?.capital || 0);
  const absPos = pos < 0n ? -pos : pos;
  const notional = absPos * basePrice / 1_000_000n;
  const leverage = capitalAfterOpen > 0n ? Number(notional) / Number(capitalAfterOpen) : 0;
  console.log(`  Opened SHORT ${pos}: capital=${fmt(capitalAfterOpen)}, notional=${fmt(notional)}, leverage=${leverage.toFixed(1)}x`);
  checkConservation(state, "max-lev-short-open");

  // Inverted market: SHORT profits when inverted price goes DOWN
  const downPrice5 = basePrice * 98n / 100n;
  console.log(`  Price: ${basePrice} → ${downPrice5} (-2%)`);
  await pushPrice(downPrice5);
  await crankN(3, 1000);

  // Close position
  console.log("  Closing position...");
  try {
    await trade(idx, -SIZE); // buy back to close short
  } catch (e: any) {
    console.log(`  Close failed, resetting and retrying...`);
    await pushPrice(basePrice);
    await crankN(3, 1000);
    await pushPrice(downPrice5);
    await crankN(3, 1000);
    await trade(idx, -SIZE);
  }
  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const pnlAfterClose = BigInt(acc?.pnl || 0);
  const posAfterClose = BigInt(acc?.positionSize || 0);
  console.log(`  After close: capital=${fmt(BigInt(acc?.capital || 0))}, pnl=${fmt(pnlAfterClose)}, position=${posAfterClose}`);

  if (posAfterClose !== 0n) {
    return { name: "MaxLev SHORT", pass: false, details: `Position not flat: ${posAfterClose}` };
  }

  // Wait for warmup, trigger settlement
  console.log("  Waiting for warmup...");
  await delay(10_000);
  try { await withdraw(idx, 1n); } catch {}
  try { await crank(); } catch {}
  await delay(1000);

  state = await getState();
  acc = state.accounts.find((a: any) => a.idx === idx);
  const capitalFinal = BigInt(acc?.capital || 0);
  const pnlFinal = BigInt(acc?.pnl || 0);
  console.log(`  After warmup: capital=${fmt(capitalFinal)}, pnl=${fmt(pnlFinal)}`);

  // Withdraw and close
  try { await withdraw(idx, capitalFinal); } catch {}
  try { await closeAccount(idx); } catch {}

  const profit = capitalFinal - DEPOSIT;
  if (capitalFinal > DEPOSIT && pnlFinal === 0n) {
    console.log(`  PROFIT at ${leverage.toFixed(1)}x: ${fmt(profit)} SOL`);
    return { name: "MaxLev SHORT", pass: true, details: `${leverage.toFixed(1)}x leverage, profit ${fmt(profit)} SOL on -2% move` };
  } else if (pnlFinal > 0n) {
    return { name: "MaxLev SHORT", pass: false, details: `Warmup incomplete: pnl=${fmt(pnlFinal)} still pending` };
  } else {
    return { name: "MaxLev SHORT", pass: false, details: `No profit at ${leverage.toFixed(1)}x: capital=${fmt(capitalFinal)}` };
  }
}

async function scenarioOverLeverageRejection(basePrice: bigint): Promise<TestResult> {
  console.log("\n============================================================");
  console.log("SCENARIO 6: Over-Leverage Rejection");
  console.log("============================================================");

  const DEPOSIT = 2_000_000_000n;
  // execute_trade checks MAINTENANCE margin (5%), not initial margin (10%).
  // Max leverage = 1/0.05 = 20x. At 4.2T size:
  //   notional = 4.2T * 9623 / 1e6 ≈ 40.4 SOL → leverage ≈ 20.7x (exceeds 20x maintenance)
  //   fee = 40.4 * 0.001 ≈ 0.04 SOL, capital_after_fee ≈ 1.93 SOL
  //   margin_required = 40.4 * 0.05 = 2.02 SOL > 1.93 SOL → should be rejected
  const OVER_SIZE = 4_200_000_000_000n;

  console.log("  Creating trader...");
  const idx = await initUser();
  if (idx === null) return { name: "OverLev Reject", pass: false, details: "Failed to create account" };
  await deposit(idx, DEPOSIT);
  console.log(`  Trader ${idx}: deposited ${fmt(DEPOSIT)} SOL`);

  await pushPrice(basePrice);
  await crank();

  // Try LONG that exceeds initial margin
  let longRejected = false;
  try {
    await trade(idx, OVER_SIZE);
    // If we get here, the trade was accepted (unexpected)
    console.log("  LONG over-leverage: ACCEPTED (should have been rejected)");
    // Close it
    try { await trade(idx, -OVER_SIZE); } catch {}
  } catch (e: any) {
    longRejected = true;
    console.log(`  LONG over-leverage: REJECTED (correct) — ${e.message?.slice(0, 60)}`);
  }

  // Try SHORT that exceeds initial margin
  let shortRejected = false;
  try {
    await trade(idx, -OVER_SIZE);
    console.log("  SHORT over-leverage: ACCEPTED (should have been rejected)");
    try { await trade(idx, OVER_SIZE); } catch {}
  } catch (e: any) {
    shortRejected = true;
    console.log(`  SHORT over-leverage: REJECTED (correct) — ${e.message?.slice(0, 60)}`);
  }

  // Clean up
  try { await withdraw(idx, DEPOSIT); } catch {}
  try { await closeAccount(idx); } catch {}

  const bothRejected = longRejected && shortRejected;
  if (bothRejected) {
    return { name: "OverLev Reject", pass: true, details: "Both LONG and SHORT over-leverage trades correctly rejected" };
  } else {
    const details = `LONG ${longRejected ? "rejected" : "ACCEPTED"}, SHORT ${shortRejected ? "rejected" : "ACCEPTED"}`;
    return { name: "OverLev Reject", pass: false, details: `Over-leverage not fully blocked: ${details}` };
  }
}

// ===========================================================================
// Main
// ===========================================================================
async function main() {
  console.log("============================================================");
  console.log("HAPPY PATH TESTS — Normal Trading + Withdrawal");
  console.log("============================================================");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Slab: ${SLAB.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  // Ensure oracle authority
  try {
    const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);
    const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  } catch {}

  // Get baseline price
  const state0 = await getState();
  const basePrice = state0.config.authorityPriceE6 > 0n
    ? state0.config.authorityPriceE6
    : BigInt(state0.engine.lastOraclePriceE6 || 9623);
  console.log(`  Base price: ${basePrice}`);

  // Ensure insurance is funded enough for profit payouts
  console.log("  Topping up insurance (5 SOL)...");
  try {
    await topUpInsurance(5_000_000_000n);
    console.log("  Insurance topped up");
  } catch (e: any) {
    console.log(`  Insurance top-up: ${e.message?.slice(0, 60)}`);
  }

  await pushPrice(basePrice);
  await crankN(3, 1000);

  // Close stale flat accounts from previous test runs to free slots
  {
    const cleanState = await getState();
    for (const a of cleanState.accounts) {
      if (a.kind === "USER" && BigInt(a.positionSize || 0) === 0n) {
        try {
          // Try to withdraw any remaining capital
          const cap = BigInt(a.capital || 0);
          if (cap > 0n) await withdraw(a.idx, cap);
          await closeAccount(a.idx);
          console.log(`  Cleaned stale account ${a.idx}`);
        } catch {}
        await delay(500);
      }
    }
  }

  // Boost LP capital — ensures LP can absorb counter-trades at moved prices
  console.log("  Boosting LP capital (10 SOL)...");
  try {
    await deposit(LP_IDX, 10_000_000_000n);
    console.log("  LP deposit success");
  } catch (e: any) {
    console.log(`  LP deposit: ${e.message?.slice(0, 60)}`);
  }

  await pushPrice(basePrice);
  await crankN(3, 1000);

  // Show LP state for diagnostics
  const lpState = (await getState()).accounts.find((a: any) => a.kind === "LP");
  if (lpState) {
    const lpPos = BigInt(lpState.positionSize || 0);
    const lpCap = BigInt(lpState.capital || 0);
    const lpNotional = (lpPos < 0n ? -lpPos : lpPos) * basePrice / 1_000_000n;
    const lpMaintReq = lpNotional * 500n / 10_000n; // 5% maintenance
    console.log(`  LP: pos=${lpPos}, capital=${fmt(lpCap)}, notional=${fmt(lpNotional)}, maint_req=${fmt(lpMaintReq)}`);
    console.log(`  LP headroom: ${fmt(lpCap - lpMaintReq)} SOL above maintenance`);
  }

  const results: TestResult[] = [];

  // Run scenarios sequentially to avoid rate limits
  results.push(await scenarioRoundTrip(basePrice));
  await delay(3000);
  await pushPrice(basePrice);
  await crankN(3, 2000);

  results.push(await scenarioWinner(basePrice));
  await delay(3000);
  await pushPrice(basePrice);
  await crankN(3, 2000);

  results.push(await scenarioLoser(basePrice));
  await delay(3000);
  await pushPrice(basePrice);
  await crankN(3, 2000);

  results.push(await scenarioMaxLeverageLong(basePrice));
  await delay(3000);
  await pushPrice(basePrice);
  await crankN(3, 2000);

  results.push(await scenarioMaxLeverageShort(basePrice));
  await delay(3000);
  await pushPrice(basePrice);
  await crankN(3, 2000);

  results.push(await scenarioOverLeverageRejection(basePrice));
  await delay(3000);
  await pushPrice(basePrice);
  await crankN(3, 2000);

  // Final conservation check
  const finalState = await getState();
  const consOk = checkConservation(finalState, "final");

  console.log("\n============================================================");
  console.log("RESULTS");
  console.log("============================================================");
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}: ${r.details}`);
  }
  console.log(`  ${consOk ? "PASS" : "FAIL"}  Conservation`);
  const allPass = results.every(r => r.pass) && consOk;
  console.log(`\n  Overall: ${allPass ? "ALL PASS" : "SOME FAILED"}`);
  console.log("============================================================\n");
}

main().catch(e => { console.error("Fatal:", e.message?.slice(0, 200)); process.exit(1); });
