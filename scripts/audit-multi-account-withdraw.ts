/**
 * Security Audit: Test withdrawal limits on multiple accounts
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function simulateWithdraw(userIdx: number, amount: bigint): Promise<boolean> {
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
  const vaultPda = new PublicKey(marketInfo.vaultPda);

  const withdrawData = encodeWithdrawCollateral({ idx: userIdx, amount });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
  );

  try {
    const sim = await conn.simulateTransaction(tx, [payer]);
    return !sim.value.err;
  } catch {
    return false;
  }
}

async function findMaxWithdraw(idx: number, capital: bigint): Promise<bigint> {
  let lo = 1n;
  let hi = capital * 2n;
  let maxSuccess = 0n;

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const success = await simulateWithdraw(idx, mid);

    if (success) {
      maxSuccess = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return maxSuccess;
}

async function main() {
  console.log("=== MULTI-ACCOUNT WITHDRAWAL TEST ===\n");

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  console.log("Engine state:");
  console.log(`  Risk reduction mode: ${engine.riskReductionOnly}`);
  console.log(`  Lifetime liquidations: ${engine.lifetimeLiquidations.toString()}`);

  const myAccounts: { idx: number; kind: string; capital: bigint; pnl: bigint }[] = [];

  // Find all my accounts
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc || !acc.owner.equals(payer.publicKey)) continue;
    myAccounts.push({
      idx,
      kind: acc.kind === AccountKind.LP ? "LP" : "USER",
      capital: acc.capital,
      pnl: acc.pnl,
    });
  }

  console.log(`\nFound ${myAccounts.length} accounts:\n`);

  // Test withdrawal on each
  for (const acc of myAccounts) {
    const capitalSol = Number(acc.capital) / 1e9;
    const pnlSol = Number(acc.pnl) / 1e9;
    const totalSol = capitalSol + pnlSol;

    console.log(`Account ${acc.idx} (${acc.kind}):`);
    console.log(`  Capital: ${capitalSol.toFixed(9)} SOL`);
    console.log(`  PnL: ${pnlSol.toFixed(9)} SOL`);
    console.log(`  Total: ${totalSol.toFixed(9)} SOL`);

    // Find max withdrawal
    console.log(`  Finding max withdrawal...`);
    const maxWithdraw = await findMaxWithdraw(acc.idx, acc.capital + acc.pnl);
    const maxSol = Number(maxWithdraw) / 1e9;
    const pct = totalSol > 0 ? (maxSol / totalSol * 100).toFixed(2) : "N/A";

    console.log(`  Max withdrawable: ${maxSol.toFixed(9)} SOL (${pct}% of total)`);
    console.log(`  Blocked: ${(totalSol - maxSol).toFixed(9)} SOL`);
    console.log();
  }

  // Calculate total withdrawable vs total capital
  let totalCapital = 0;
  let totalWithdrawable = 0;

  for (const acc of myAccounts) {
    totalCapital += Number(acc.capital) / 1e9 + Number(acc.pnl) / 1e9;
    const max = await findMaxWithdraw(acc.idx, acc.capital + acc.pnl);
    totalWithdrawable += Number(max) / 1e9;
  }

  console.log("=== SUMMARY ===");
  console.log(`Total capital + PnL: ${totalCapital.toFixed(9)} SOL`);
  console.log(`Total withdrawable: ${totalWithdrawable.toFixed(9)} SOL`);
  console.log(`Total blocked: ${(totalCapital - totalWithdrawable).toFixed(9)} SOL`);
  console.log(`Blocked %: ${((totalCapital - totalWithdrawable) / totalCapital * 100).toFixed(2)}%`);
}

main().catch(console.error);
