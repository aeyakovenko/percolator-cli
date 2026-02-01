/**
 * Worst-Case Stress Test v2 — Gap Risk + Insurance Exhaustion
 *
 * Strategy: Simulate oracle gap risk that blows through liquidation levels.
 * 1. Boost LP capital so it can absorb large counterparty positions
 * 2. Fund 5 traders with 2 SOL each
 * 3. Open near-max leverage LONG positions (2T units = ~9.6x leverage)
 * 4. Gap price DOWN 20% in ONE step WITHOUT cranking (gap risk)
 *    - Traders are deeply underwater: -1.87 SOL each = -9.34 SOL total bad debt
 *    - Insurance fund only has ~1.6 SOL → CANNOT cover all bad debt
 * 5. NOW crank → liquidation cascade with underwater accounts
 * 6. Check for socialized losses (lossAccum > 0)
 * 7. Bank run — LP (profitable SHORT) tries to withdraw
 * 8. Full solvency analysis
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseParams, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral, encodeInitUser, encodePushOraclePrice, encodeSetOracleAuthority } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import * as fs from "fs";

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
const fmtPct = (n: number) => n.toFixed(2) + "%";

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

async function crank() {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function setOracleAuthority() {
  const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function pushPrice(priceE6: bigint) {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: timestamp.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function initUser(): Promise<number | null> {
  const beforeState = await getState();
  const beforeIndices = new Set(parseUsedIndices(beforeState.data));
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeInitUser({ feePayment: "1000000" }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  const afterState = await getState();
  for (const idx of parseUsedIndices(afterState.data)) {
    if (!beforeIndices.has(idx)) return idx;
  }
  return null;
}

async function deposit(accountIdx: number, amount: bigint) {
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  // Wrap SOL
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
    vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, config.indexFeedId,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeWithdrawCollateral({ userIdx, amount: amount.toString() }) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

function printState(label: string, state: any) {
  const engine = state.engine;
  const insurance = BigInt(engine.insuranceFund?.balance || 0);
  const vault = BigInt(engine.vault || 0);
  const lossAccum = BigInt(engine.lossAccum || 0);
  const threshold = BigInt(state.params.riskReductionThreshold || 0);
  const surplus = insurance > threshold ? insurance - threshold : 0n;

  console.log(`\n>>> ${label} <<<`);
  console.log(`  Vault:      ${fmt(vault)} SOL`);
  console.log(`  Insurance:  ${fmt(insurance)} SOL (threshold: ${fmt(threshold)}, surplus: ${fmt(surplus)})`);
  console.log(`  LossAccum:  ${fmt(lossAccum)} SOL`);
  console.log(`  RiskReduce: ${engine.riskReductionOnly}`);
  console.log(`  Liqs: ${engine.lifetimeLiquidations}, ForceClose: ${engine.lifetimeForceCloses}`);
  console.log(`  Accounts:`);
  for (const acc of state.accounts) {
    const pos = BigInt(acc.positionSize || 0);
    const cap = BigInt(acc.capital || 0);
    const pnl = BigInt(acc.pnl || 0);
    const dir = pos > 0n ? "LONG" : pos < 0n ? "SHORT" : "FLAT";
    console.log(`    ${acc.kind} ${acc.idx}: ${dir} ${pos}, capital=${fmt(cap)}, pnl=${fmt(pnl)}`);
  }
}

async function main() {
  console.log("============================================================");
  console.log("WORST-CASE STRESS TEST v2 — Gap Risk + Insurance Exhaustion");
  console.log("============================================================\n");

  // 1. Capture initial state
  let state = await getState();
  printState("INITIAL STATE", state);

  const initialLiqs = state.engine.lifetimeLiquidations;
  const initialForceCloses = state.engine.lifetimeForceCloses;
  const initialInsurance = BigInt(state.engine.insuranceFund?.balance || 0);
  const initialLossAccum = BigInt(state.engine.lossAccum || 0);

  // 2. Set oracle authority for price manipulation
  console.log("\n>>> SETTING ORACLE AUTHORITY <<<");
  try {
    await setOracleAuthority();
    console.log("  Oracle authority set to admin");
  } catch (e: any) {
    console.log(`  Already set or error: ${e.message?.slice(0, 50)}`);
  }

  // Get baseline price
  const basePrice = BigInt(state.engine.lastOraclePriceE6 || 9623);
  console.log(`  Baseline price: ${basePrice}`);

  // Reset to baseline and crank
  await pushPrice(basePrice);
  await crank();

  // 3. Boost LP capital so it can absorb large counterparty positions
  console.log("\n>>> BOOSTING LP CAPITAL <<<");
  const LP_BOOST = 10_000_000_000n; // 10 SOL
  try {
    console.log(`  Depositing ${fmt(LP_BOOST)} SOL to LP (account ${LP_IDX})...`);
    await deposit(LP_IDX, LP_BOOST);
    console.log("  LP deposit success");
  } catch (e: any) {
    console.log(`  LP deposit failed: ${e.message?.slice(0, 80)}`);
  }

  await crank();
  state = await getState();
  const lpAfterBoost = state.accounts.find((a: any) => a.kind === "LP");
  console.log(`  LP capital after boost: ${fmt(BigInt(lpAfterBoost?.capital || 0))} SOL`);

  // 4. Create and fund 5 traders with 2 SOL each
  console.log("\n>>> SETTING UP 5 TRADERS (2 SOL each) <<<");
  const TRADER_DEPOSIT = 2_000_000_000n; // 2 SOL each
  const NUM_TRADERS = 5;
  const traderIndices: number[] = [];

  state = await getState();
  const existingUsers = state.accounts.filter((a: any) => a.kind === "USER");

  for (const u of existingUsers) {
    if (traderIndices.length < NUM_TRADERS) traderIndices.push(u.idx);
  }

  while (traderIndices.length < NUM_TRADERS) {
    console.log(`  Creating trader ${traderIndices.length + 1}...`);
    const idx = await initUser();
    if (idx === null) { console.log("  FAILED to create"); break; }
    traderIndices.push(idx);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  Traders: [${traderIndices.join(", ")}]`);

  for (const idx of traderIndices) {
    try {
      console.log(`  Depositing ${fmt(TRADER_DEPOSIT)} SOL to trader ${idx}...`);
      await deposit(idx, TRADER_DEPOSIT);
      console.log(`    OK`);
    } catch (e: any) {
      console.log(`    Failed: ${e.message?.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  await crank();
  state = await getState();
  printState("AFTER FUNDING", state);

  // 5. Open near-max leverage LONG positions
  //    2T units ≈ 19.2 SOL notional at price 9623 → 9.6x leverage on 2 SOL
  //    In inverted market, LONG = benefits from inverted price going UP
  //    To hurt: push inverted price DOWN
  console.log("\n>>> OPENING NEAR-MAX LEVERAGE POSITIONS (ALL LONG, ~9.6x) <<<");

  const TRADE_SIZE = 2_000_000_000_000n; // 2T units ≈ 19.2 SOL notional at 9623

  // Calculate expected leverage
  const tradeNotional = Number(TRADE_SIZE) * Number(basePrice) / 1e6;
  const leverage = tradeNotional / Number(TRADER_DEPOSIT);
  console.log(`  Trade size: ${TRADE_SIZE} units`);
  console.log(`  Notional per trade: ~${(tradeNotional / 1e9).toFixed(3)} SOL`);
  console.log(`  Leverage: ~${leverage.toFixed(1)}x`);
  console.log(`  Liquidation at: ~${(1 / leverage / 2 * 100).toFixed(1)}% price move`);
  console.log(`  Bankruptcy at:  ~${(1 / leverage * 100).toFixed(1)}% price move\n`);

  let tradesSucceeded = 0;
  for (const idx of traderIndices) {
    try {
      console.log(`  Trader ${idx}: opening LONG +${TRADE_SIZE}...`);
      await trade(idx, TRADE_SIZE);
      console.log(`    ✓ Success (${leverage.toFixed(1)}x leverage)`);
      tradesSucceeded++;
    } catch (e: any) {
      console.log(`    ✗ Failed: ${e.message?.slice(0, 80)}`);
      // Try half size
      try {
        const half = TRADE_SIZE / 2n;
        console.log(`    Retrying with half size (${half})...`);
        await trade(idx, half);
        console.log(`    ✓ Half-size success`);
        tradesSucceeded++;
      } catch (e2: any) {
        console.log(`    ✗ Half-size also failed: ${e2.message?.slice(0, 60)}`);
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n  ${tradesSucceeded}/${NUM_TRADERS} trades executed`);

  // DO NOT CRANK — we want positions to exist when price gaps
  state = await getState();
  printState("POSITIONS OPEN (before crash)", state);

  // Calculate theoretical damage from 20% crash
  console.log("\n>>> THEORETICAL DAMAGE ANALYSIS <<<");
  for (const acc of state.accounts) {
    if (acc.kind === "USER") {
      const pos = BigInt(acc.positionSize || 0);
      const cap = BigInt(acc.capital || 0);
      const entry = BigInt(acc.entryPriceE6 || 0);
      if (pos !== 0n) {
        const crashPrice = basePrice * 80n / 100n;
        const pnl = pos * (crashPrice - entry) / 1_000_000n;
        const effectiveCap = cap + pnl;
        console.log(`  Trader ${acc.idx}: pos=${pos}, capital=${fmt(cap)}`);
        console.log(`    At -20%: PnL=${fmt(pnl)}, effective=${fmt(effectiveCap)} ${effectiveCap < 0n ? "** UNDERWATER **" : ""}`);
      }
    }
  }

  // 6. GAP RISK: Push price 20% DOWN in ONE step WITHOUT cranking
  //    This simulates a flash crash where the oracle updates but crank is delayed
  console.log("\n============================================================");
  console.log("PHASE 1: GAP RISK — 20% CRASH (NO CRANK)");
  console.log("============================================================");

  const gapPrice = basePrice * 80n / 100n;
  console.log(`\n  Pushing price: ${basePrice} -> ${gapPrice} (20% crash)`);
  console.log("  ⚠ NOT CRANKING — simulating delayed crank / gap risk");
  await pushPrice(gapPrice);

  // Show state with new price but before liquidations
  state = await getState();
  printState("AFTER GAP (before crank)", state);

  // 7. NOW crank — this should trigger liquidation cascade
  console.log("\n============================================================");
  console.log("PHASE 2: CRANKING — LIQUIDATION CASCADE");
  console.log("============================================================");

  for (let i = 0; i < 15; i++) {
    try {
      await crank();
      // Check state after each crank
      const s = await getState();
      const liqs = s.engine.lifetimeLiquidations - initialLiqs;
      const loss = BigInt(s.engine.lossAccum || 0);
      const ins = BigInt(s.engine.insuranceFund?.balance || 0);
      if (liqs > 0 || loss > 0n) {
        console.log(`  Crank ${i + 1}: +${liqs} liquidations, lossAccum=${fmt(loss)}, insurance=${fmt(ins)}`);
      }
    } catch (e: any) {
      console.log(`  Crank ${i + 1}: ${e.message?.slice(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  state = await getState();
  printState("AFTER LIQUIDATION CASCADE", state);

  // 8. Push even harder — 50% crash
  console.log("\n============================================================");
  console.log("PHASE 3: EXTREME CRASH — 50% DOWN");
  console.log("============================================================");

  const extremePrice = basePrice * 50n / 100n;
  console.log(`\n  Pushing price: ${basePrice} -> ${extremePrice} (50% crash)`);
  await pushPrice(extremePrice);

  // Crank aggressively
  for (let i = 0; i < 15; i++) {
    try { await crank(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  state = await getState();
  printState("AFTER 50% CRASH", state);

  // 9. Bank run — profitable side (LP is SHORT, profits from crash) tries to withdraw
  console.log("\n============================================================");
  console.log("PHASE 4: BANK RUN");
  console.log("============================================================");

  state = await getState();

  // LP bank run (LP should be profitable as the SHORT counterparty)
  const lp = state.accounts.find((a: any) => a.kind === "LP");
  if (lp) {
    const lpCap = BigInt(lp.capital || 0);
    const lpPos = BigInt(lp.positionSize || 0);
    console.log(`\n  LP: capital=${fmt(lpCap)}, position=${lpPos}`);

    // LP can't withdraw with open position exceeding margin, try small amounts
    if (lpCap > 0n) {
      // Try to withdraw 50% of LP capital
      const lpWithdraw = lpCap / 2n;
      try {
        console.log(`  LP withdrawing ${fmt(lpWithdraw)} SOL (50% of capital)...`);
        await withdraw(LP_IDX, lpWithdraw);
        console.log(`    ✓ LP WITHDRAWAL SUCCESS`);
      } catch (e: any) {
        console.log(`    ✗ LP blocked: ${e.message?.slice(0, 80)}`);
      }
    }
  }

  // Trader bank run — any survivors try to withdraw
  for (const acc of state.accounts) {
    if (acc.kind === "USER") {
      const cap = BigInt(acc.capital || 0);
      const pos = BigInt(acc.positionSize || 0);
      if (cap > 0n) {
        const label = pos === 0n ? "(flat)" : "(has position)";
        try {
          console.log(`  Trader ${acc.idx} ${label}: withdrawing ${fmt(cap)} SOL...`);
          await withdraw(acc.idx, cap);
          console.log(`    ✓ SUCCESS`);
        } catch (e: any) {
          console.log(`    ✗ BLOCKED: ${e.message?.slice(0, 60)}`);
          if (pos === 0n) {
            try {
              await withdraw(acc.idx, cap / 2n);
              console.log(`    Partial: ${fmt(cap / 2n)} SOL`);
            } catch { console.log(`    Fully blocked`); }
          }
        }
      }
    }
  }

  // 10. Final state
  state = await getState();
  printState("FINAL STATE", state);

  // 11. Full analysis
  console.log("\n============================================================");
  console.log("FULL ANALYSIS");
  console.log("============================================================");

  const finalInsurance = BigInt(state.engine.insuranceFund?.balance || 0);
  const finalLossAccum = BigInt(state.engine.lossAccum || 0);
  const finalVault = BigInt(state.engine.vault || 0);
  const riskReduction = state.engine.riskReductionOnly;
  const newLiqs = state.engine.lifetimeLiquidations - initialLiqs;
  const newForceCloses = state.engine.lifetimeForceCloses - initialForceCloses;

  console.log(`\n  === Counters ===`);
  console.log(`  New liquidations:  ${newLiqs}`);
  console.log(`  New force closes:  ${newForceCloses}`);
  console.log(`  Risk-reduction:    ${riskReduction}`);

  console.log(`\n  === Insurance ===`);
  console.log(`  Before:           ${fmt(initialInsurance)} SOL`);
  console.log(`  After:            ${fmt(finalInsurance)} SOL`);
  console.log(`  Change:           ${fmt(finalInsurance - initialInsurance)} SOL`);

  console.log(`\n  === Socialized Losses ===`);
  console.log(`  Before:           ${fmt(initialLossAccum)} SOL`);
  console.log(`  After:            ${fmt(finalLossAccum)} SOL`);
  console.log(`  New losses:       ${fmt(finalLossAccum - initialLossAccum)} SOL`);

  if (finalLossAccum > initialLossAccum) {
    console.log("\n  *** SOCIALIZED LOSSES DETECTED ***");
    console.log(`  Insurance fund was insufficient to cover all bad debt`);
    console.log(`  ${fmt(finalLossAccum - initialLossAccum)} SOL socialized across remaining positions`);
  } else {
    console.log("\n  Insurance fund absorbed all losses (no socialized losses)");
  }

  if (riskReduction) {
    console.log("  Market entered risk-reduction-only mode");
  }

  // Solvency check
  console.log(`\n  === Solvency Check ===`);
  let totalCapital = 0n;
  for (const acc of state.accounts) {
    totalCapital += BigInt(acc.capital || 0);
  }

  console.log(`  Total capital:     ${fmt(totalCapital)} SOL`);
  console.log(`  Insurance:         ${fmt(finalInsurance)} SOL`);
  console.log(`  Capital+Insurance: ${fmt(totalCapital + finalInsurance)} SOL`);
  console.log(`  Vault balance:     ${fmt(finalVault)} SOL`);

  const deficit = totalCapital + finalInsurance - finalVault;
  if (finalVault >= totalCapital + finalInsurance) {
    console.log(`  Surplus:           ${fmt(finalVault - totalCapital - finalInsurance)} SOL`);
    console.log("  SOLVENCY: ✓ MAINTAINED");
  } else {
    console.log(`  DEFICIT:           ${fmt(deficit)} SOL`);
    console.log("  *** SOLVENCY VIOLATION ***");
  }

  // Reset price back
  console.log("\n>>> RESETTING PRICE TO BASELINE <<<");
  await pushPrice(basePrice);
  for (let i = 0; i < 5; i++) {
    try { await crank(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("  Price reset complete");

  // Final state after reset
  state = await getState();
  printState("STATE AFTER PRICE RESET", state);

  console.log("\n============================================================");
  console.log("STRESS TEST v2 COMPLETE");
  console.log("============================================================");
}

main().catch(e => console.error("Fatal:", e.message?.slice(0, 200)));
