/**
 * Security Audit: Find Maximum Withdrawal
 *
 * Binary search to find the exact maximum withdrawal amount
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseConfig, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
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

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    config: parseConfig(data),
    engine: parseEngine(data),
    data,
    vaultBalance: vaultInfo ? vaultInfo.lamports / 1e9 : 0,
  };
}

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

async function findMyAccounts(): Promise<{users: number[], lps: number[]}> {
  const { data } = await getState();
  const indices = parseUsedIndices(data);
  const users: number[] = [];
  const lps: number[] = [];

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;
    if (acc.owner.equals(payer.publicKey)) {
      if (acc.kind === AccountKind.LP) {
        lps.push(idx);
      } else {
        users.push(idx);
      }
    }
  }
  return { users, lps };
}

async function main() {
  console.log("=== FIND MAXIMUM WITHDRAWAL ===\n");

  const { users } = await findMyAccounts();
  if (users.length === 0) {
    console.log("ERROR: No user accounts found");
    return;
  }

  const userIdx = users[0];
  console.log(`User account: ${userIdx}`);

  // Get current state
  const { data, engine } = await getState();
  const acc = parseAccount(data, userIdx);
  if (!acc) {
    console.log("ERROR: Account not found");
    return;
  }

  const capital = Number(acc.capital);
  const pnl = Number(acc.pnl);
  const capitalSol = capital / 1e9;
  const pnlSol = pnl / 1e9;

  console.log(`\n=== ACCOUNT STATE ===`);
  console.log(`Capital: ${capitalSol.toFixed(9)} SOL (${capital} lamports)`);
  console.log(`PnL: ${pnlSol.toFixed(9)} SOL (${pnl} lamports)`);
  console.log(`Capital + PnL: ${((capital + pnl) / 1e9).toFixed(9)} SOL`);
  console.log(`Position Size: ${acc.positionSize.toString()}`);

  // Binary search for max withdrawal
  console.log("\n=== BINARY SEARCH FOR MAX WITHDRAWAL ===");

  let lo = 1n;
  let hi = BigInt(capital + pnl + 1_000_000_000); // Search up to capital + PnL + 1 SOL
  let maxSuccess = 0n;

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const success = await simulateWithdraw(userIdx, mid);

    if (success) {
      maxSuccess = mid;
      lo = mid + 1n;
      console.log(`  ${(Number(mid) / 1e9).toFixed(9)} SOL: SUCCESS`);
    } else {
      hi = mid - 1n;
      console.log(`  ${(Number(mid) / 1e9).toFixed(9)} SOL: FAIL`);
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`Maximum withdrawal: ${(Number(maxSuccess) / 1e9).toFixed(9)} SOL`);
  console.log(`As lamports: ${maxSuccess.toString()}`);

  // Compare to capital
  const maxSol = Number(maxSuccess) / 1e9;
  console.log(`\n=== ANALYSIS ===`);
  console.log(`Capital: ${capitalSol.toFixed(9)} SOL`);
  console.log(`PnL: ${pnlSol.toFixed(9)} SOL`);
  console.log(`Capital + PnL: ${((capital + pnl) / 1e9).toFixed(9)} SOL`);
  console.log(`Max withdrawable: ${maxSol.toFixed(9)} SOL`);
  console.log(`Difference from capital: ${(maxSol - capitalSol).toFixed(9)} SOL`);
  console.log(`Percent of capital: ${(maxSol / capitalSol * 100).toFixed(2)}%`);

  // Check what's blocking full withdrawal
  if (maxSol < capitalSol) {
    console.log(`\n*** WITHDRAWAL LIMITED ***`);
    console.log(`Unable to withdraw ${(capitalSol - maxSol).toFixed(9)} SOL of capital`);

    // Check if it's related to maintenance margin or other constraints
    const insuranceSol = Number(engine.insuranceFund.balance) / 1e9;
    const { vaultBalance } = await getState();

    console.log(`\nPossible constraints:`);
    console.log(`  - Vault balance: ${vaultBalance.toFixed(9)} SOL`);
    console.log(`  - Insurance fund: ${insuranceSol.toFixed(9)} SOL`);
    console.log(`  - Risk reduction mode: ${engine.riskReductionOnly}`);
  }
}

main().catch(console.error);
