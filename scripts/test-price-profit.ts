/**
 * Test Price Change Profit Withdrawal
 *
 * 1. Set oracle authority to admin
 * 2. Push a price change to make trader profitable
 * 3. Close position to realize profit
 * 4. Withdraw the profit
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeSetOracleAuthority, encodeWithdrawCollateral, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

interface AccountState {
  idx: number;
  kind: string;
  position: bigint;
  capital: bigint;
  pnl: bigint;
}

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const accounts: AccountState[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      accounts.push({
        idx,
        kind: acc.kind === AccountKind.LP ? "LP" : "USER",
        position: BigInt(acc.positionSize || 0),
        capital: BigInt(acc.capital || 0),
        pnl: BigInt(acc.pnl || 0),
      });
    }
  }
  return { engine, config, accounts };
}

async function setOracleAuthority(newAuthority: PublicKey) {
  const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);
  const ix = buildIx({
    programId: PROGRAM_ID, keys,
    data: encodeSetOracleAuthority({ newAuthority }),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function pushPrice(priceE6: bigint) {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const ix = buildIx({
    programId: PROGRAM_ID, keys,
    data: encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: timestamp.toString() }),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function runCrank() {
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 0, allowPanic: false }) });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function closePosition(lpIdx: number, userIdx: number, size: bigint) {
  const matcherCtx = new PublicKey(marketInfo.lp.matcherContext);
  const lpPda = new PublicKey(marketInfo.lp.pda);
  const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, matcherCtx, lpPda,
  ]);
  const ix = buildIx({
    programId: PROGRAM_ID, keys,
    data: encodeTradeCpi({ lpIdx, userIdx, size: size.toString() }),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix
  );
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
  const ix = buildIx({
    programId: PROGRAM_ID, keys,
    data: encodeWithdrawCollateral({ userIdx, amount: amount.toString() }),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);

async function openPosition(lpIdx: number, userIdx: number, size: bigint) {
  const matcherCtx = new PublicKey(marketInfo.lp.matcherContext);
  const lpPda = new PublicKey(marketInfo.lp.pda);
  const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, matcherCtx, lpPda,
  ]);
  const ix = buildIx({
    programId: PROGRAM_ID, keys,
    data: encodeTradeCpi({ lpIdx, userIdx, size: size.toString() }),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function main() {
  console.log("=== PRICE CHANGE PROFIT TEST ===\n");

  // Set oracle authority to admin
  console.log(">>> SETTING ORACLE AUTHORITY <<<");
  try {
    await setOracleAuthority(payer.publicKey);
    console.log(`Set oracle authority to: ${payer.publicKey.toBase58()}`);
  } catch (e: any) {
    console.log(`Authority already set or error: ${e.message?.slice(0, 50)}`);
  }

  // Reset price to baseline
  const basePrice = 8149n;
  console.log(`\nResetting price to baseline: ${basePrice}`);
  await pushPrice(basePrice);
  await runCrank();

  // Initial state
  console.log("\n>>> INITIAL STATE <<<");
  let state = await getState();

  for (const acc of state.accounts) {
    const kind = acc.kind;
    const pos = acc.position;
    console.log(`${kind} ${acc.idx}: pos=${pos}, capital=${fmt(acc.capital)}, pnl=${fmt(acc.pnl)}`);
  }

  // Find user with position, or use user 10 if it has capital
  let user = state.accounts.find(a => a.kind === "USER" && a.position !== 0n);

  if (!user) {
    // Find user with capital but no position
    const userWithCapital = state.accounts.find(a => a.kind === "USER" && a.capital > 0n);

    if (!userWithCapital) {
      console.log("No user with position or capital found. Need to create/fund an account first.");
      return;
    }

    // Open a position for this user
    console.log(`\n>>> OPENING POSITION FOR USER ${userWithCapital.idx} <<<`);
    const tradeSize = 50_000_000_000n; // 50B units (about 0.4 SOL notional at 8149 price)

    try {
      await openPosition(0, userWithCapital.idx, tradeSize);
      console.log(`Opened LONG position: ${tradeSize} units`);
    } catch (e: any) {
      console.log(`Failed to open position: ${e.message?.slice(0, 80)}`);
      return;
    }

    await runCrank();

    // Refresh state
    state = await getState();
    user = state.accounts.find(a => a.idx === userWithCapital.idx);
  }

  if (!user || user.position === 0n) {
    console.log("Failed to establish position");
    return;
  }

  // Current oracle price (from chainlink oracle ~8000-8200 in inverted units)
  const currentPrice = 8149n;

  // Calculate new price (10% move in favor of the position)
  // Standard PnL formula: position * (current_price - entry_price)
  // - LONG (positive position) profits when price goes UP
  // - SHORT (negative position) profits when price goes DOWN
  //
  // Note: In inverted market, higher inverted price = lower underlying price,
  // but the PnL math is standard based on the inverted price units.
  const newPrice = user.position > 0n
    ? currentPrice * 110n / 100n  // LONG: price UP = profit
    : currentPrice * 90n / 100n;  // SHORT: price DOWN = profit

  console.log(`\n>>> PUSHING PRICE: ${currentPrice} -> ${newPrice} (10% move) <<<`);
  console.log(`Position is ${user.position > 0n ? "LONG" : "SHORT"}`);
  console.log(`Moving price ${user.position > 0n ? "UP" : "DOWN"} to make trader profitable`);

  await pushPrice(newPrice);
  console.log("Price pushed successfully");

  // Run crank to update PnL
  console.log("\n>>> RUNNING CRANK <<<");
  await runCrank();
  console.log("Crank complete");

  // Check new state
  console.log("\n>>> STATE AFTER PRICE MOVE <<<");
  state = await getState();

  const userAfter = state.accounts.find(a => a.idx === user.idx);
  const entryPrice = state.config.authorityPriceE6 ? BigInt(state.config.authorityPriceE6) : 8149n;

  if (userAfter) {
    const dir = userAfter.position > 0n ? "LONG" : "SHORT";

    // Calculate unrealized PnL: position * (current_price - entry_price) / 1e6
    // Entry price is roughly the baseline, current is new pushed price
    const unrealizedPnl = userAfter.position * (newPrice - basePrice) / 1_000_000n;

    console.log(`USER ${userAfter.idx}: ${dir} ${userAfter.position}`);
    console.log(`  Capital:       ${fmt(userAfter.capital)} SOL`);
    console.log(`  Realized PnL:  ${Number(userAfter.pnl) >= 0 ? "+" : ""}${fmt(userAfter.pnl)} SOL`);
    console.log(`  Unrealized:    ${Number(unrealizedPnl) >= 0 ? "+" : ""}${fmt(unrealizedPnl)} SOL (estimate)`);
    console.log(`  Total equity:  ${fmt(userAfter.capital + userAfter.pnl + unrealizedPnl)} SOL`);

    if (unrealizedPnl > 0n) {
      console.log("\n>>> TRADER IS PROFITABLE! <<<");
      console.log("Closing position to realize profit...");

      try {
        await closePosition(0, userAfter.idx, -userAfter.position);
        console.log("Position closed");
      } catch (e: any) {
        console.log(`Close failed: ${e.message?.slice(0, 80)}`);
        return;
      }

      await runCrank();

      state = await getState();
      const userClosed = state.accounts.find(a => a.idx === user.idx);

      if (userClosed) {
        console.log(`\n>>> AFTER CLOSE <<<`);
        console.log(`  Capital: ${fmt(userClosed.capital)} SOL (includes realized profit)`);
        console.log(`  Position: ${userClosed.position}`);

        if (userClosed.position === 0n && userClosed.capital > 0n) {
          console.log(`\n>>> WITHDRAWING PROFIT: ${fmt(userClosed.capital)} SOL <<<`);

          try {
            await withdraw(userClosed.idx, userClosed.capital);
            console.log("WITHDRAWAL SUCCESSFUL!");

            state = await getState();
            const userFinal = state.accounts.find(a => a.idx === user.idx);
            console.log(`  Final capital: ${fmt(userFinal?.capital || 0n)} SOL`);
          } catch (e: any) {
            console.log(`Withdrawal failed: ${e.message?.slice(0, 80)}`);
          }
        }
      }
    } else {
      console.log("\n  Position shows loss or flat");
      console.log("  This can happen if:");
      console.log("  - Price moved opposite to position");
      console.log("  - Entry price was different than expected");
    }
  }

  console.log("\n=== TEST COMPLETE ===");
}

main().catch(e => console.error("Error:", e.message?.slice(0, 200)));
