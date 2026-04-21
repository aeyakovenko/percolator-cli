/**
 * Maintenance-fee keeper-sweep verification (incl. 50/50 keeper reward).
 *
 * Spec (wrapper src/percolator.rs:5173): after each KeeperCrank sweep,
 * CRANK_REWARD_BPS = 5_000 (50%) of `sweep_delta` is paid back to
 * `caller_idx` as capital; the remaining 50% stays in insurance.
 * Permissionless cranks (caller_idx = u16::MAX) skip the reward.
 *
 * This test materializes LP (idx 0) + user (idx 1), lets slots pass,
 * issues a KeeperCrank with caller_idx = 0 (LP), and asserts:
 *   - user.lastFeeSlot advanced; user.capital decreased by full fee.
 *   - lp.lastFeeSlot advanced; lp capital = lp_prev − lp_fee + reward.
 *   - insurance gained exactly 50% of (user_fee + lp_fee).
 *   - reward paid to LP = insurance_gain (50/50 split).
 *   - vault == SPL; vault >= cTot + insurance (conservation).
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket, encodeInitUser, encodeInitLP,
  encodeDepositCollateral, encodeKeeperCrank,
  encodeSetOracleAuthority, encodePushOraclePrice,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_USER, ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { parseEngine, parseAccount, fetchSlab } from "../src/solana/slab.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";
import { defaultInitMarketArgs } from "./_default-market.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROG = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const SLAB_SIZE = 1_525_656;
const MAINT_FEE_PER_SLOT = "1000000"; // 1M engine units per slot per account

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))
));

async function tx(ixs: any[], signers: Keypair[], cu = 300_000) {
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  for (const ix of ixs) t.add(ix);
  return sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed" });
}

async function getSpl(vault: PublicKey): Promise<bigint> {
  return (await getAccount(conn, vault)).amount;
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}  ${detail || ""}`); }
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║ MAINTENANCE-FEE KEEPER-SWEEP VERIFICATION    ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`maintenance_fee_per_slot = ${MAINT_FEE_PER_SLOT}\n`);

  const slab = Keypair.generate();
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  const [vaultAuth] = deriveVaultAuthority(PROG, slab.publicKey);
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);

  await tx([SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
    lamports: rent, space: SLAB_SIZE, programId: PROG,
  })], [payer, slab], 50_000);

  const vAcc = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vaultAuth, true);
  const vault = vAcc.address;
  const payerAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  await mintTo(conn, payer, mint, payerAta.address, payer, 10_000_000_000);

  // InitMarket with nonzero maintenance fee
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, mint, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent, vaultAuth, WELL_KNOWN.systemProgram,
    ]),
    data: encodeInitMarket(defaultInitMarketArgs(payer.publicKey, mint, {
      maintenanceFeePerSlot: MAINT_FEE_PER_SLOT,
    })),
  })], [payer], 300_000);

  // SetOracleAuthority + PushOraclePrice
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, payer.publicKey, slab.publicKey]),
    data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }),
  })], [payer]);
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
    data: encodePushOraclePrice({ priceE6: "100000000", timestamp: Math.floor(Date.now()/1000).toString() }),
  })], [payer]);

  // Create LP (idx 0)
  const matcherCtx = Keypair.generate();
  const [lpPda] = deriveLpPda(PROG, slab.publicKey, 0);
  const matcherInitData = Buffer.alloc(66);
  matcherInitData[0] = 2; matcherInitData[1] = 0;
  matcherInitData.writeUInt32LE(50, 2);
  matcherInitData.writeUInt32LE(50, 6);
  matcherInitData.writeUInt32LE(1000, 10);
  matcherInitData.writeBigUInt64LE(1_000_000_000n, 18);
  matcherInitData.writeBigUInt64LE(100_000_000n, 34);
  matcherInitData.writeBigUInt64LE(100_000_000n, 50);

  await tx([
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(320),
      space: 320, programId: MATCHER,
    }),
    { programId: MATCHER, keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
    ], data: matcherInitData },
    buildIx({ programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_INIT_LP, [
        payer.publicKey, slab.publicKey, payerAta.address, vault,
        WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
      ]),
      data: encodeInitLP({ matcherProgram: MATCHER, matcherContext: matcherCtx.publicKey, feePayment: "1000000" }),
    }),
  ], [payer, matcherCtx], 300_000);

  // Create user (idx 1)
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
      payer.publicKey, slab.publicKey, payerAta.address, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]),
    data: encodeInitUser({ feePayment: "1000000" }),
  })], [payer]);

  // Deposit 100M into user, 200M into LP.
  // LP needs enough capital to pay its own maintenance fee in full
  // (otherwise the shortfall is routed to fee_credits debt, which is
  // NOT included in sweep_delta — the 50/50 split only covers what the
  // sweep actually moves into insurance).
  const USER_DEPOSIT = 100_000_000n;
  const LP_DEPOSIT = 200_000_000n;
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, slab.publicKey, payerAta.address, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]),
    data: encodeDepositCollateral({ userIdx: 1, amount: USER_DEPOSIT.toString() }),
  })], [payer]);
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, slab.publicKey, payerAta.address, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]),
    data: encodeDepositCollateral({ userIdx: 0, amount: LP_DEPOSIT.toString() }),
  })], [payer]);

  const buf0 = await fetchSlab(conn, slab.publicKey);
  const e0 = parseEngine(buf0);
  const u0 = parseAccount(buf0, 1);
  const lp0 = parseAccount(buf0, 0);
  const spl0 = await getSpl(vault);
  console.log(`\n=== Pre-wait snapshot ===`);
  console.log(`  vault=${e0.vault} insurance=${e0.insuranceFund.balance} cTot=${e0.cTot}`);
  console.log(`  user[1] capital=${u0.capital} lastFeeSlot=${u0.lastFeeSlot}`);
  console.log(`  lp[0]   capital=${lp0.capital} lastFeeSlot=${lp0.lastFeeSlot}`);
  console.log(`  SPL=${spl0} currentSlot=${e0.currentSlot}`);
  check("init: vault == SPL", e0.vault === spl0);
  check("init: vault >= cTot + insurance", e0.vault >= e0.cTot + e0.insuranceFund.balance);

  console.log(`\n=== Waiting 20s for slot progression, then 1 crank (caller=LP idx 0) ===`);
  await new Promise(r => setTimeout(r, 20000));

  // Single crank with caller_idx = 0 (LP). Non-permissionless → reward paid.
  // Pass LP's owner as the caller signer slot (accounts[0]), LP does not
  // need to sign — the wrapper credits reward by idx, not by key.
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
    ]),
    data: encodeKeeperCrank({ callerIdx: 0, candidates: [] }),
  })], [payer], 400_000);

  const buf1 = await fetchSlab(conn, slab.publicKey);
  const e1 = parseEngine(buf1);
  const u1 = parseAccount(buf1, 1);
  const lp1 = parseAccount(buf1, 0);
  const spl1 = await getSpl(vault);

  console.log(`\n=== Post-crank snapshot ===`);
  console.log(`  vault=${e1.vault} insurance=${e1.insuranceFund.balance} cTot=${e1.cTot}`);
  console.log(`  user[1] capital=${u1.capital} lastFeeSlot=${u1.lastFeeSlot}`);
  console.log(`  lp[0]   capital=${lp1.capital} lastFeeSlot=${lp1.lastFeeSlot}`);
  console.log(`  SPL=${spl1} currentSlot=${e1.currentSlot}`);

  const rate = BigInt(MAINT_FEE_PER_SLOT);
  const userDt = u1.lastFeeSlot - u0.lastFeeSlot;
  const lpDt = lp1.lastFeeSlot - lp0.lastFeeSlot;
  const userFee = userDt * rate;
  const lpFee = lpDt * rate;
  const totalFees = userFee + lpFee;
  const expectedReward = totalFees / 2n;           // 50/50 split
  const expectedInsGain = totalFees - expectedReward;
  const userCapDrop = u0.capital - u1.capital;     // user paid fee, no reward
  const lpCapDelta = lp1.capital - lp0.capital;    // lp paid fee then received reward
  const lpNetDrop = -lpCapDelta;                   // negative means lp gained (reward > fee)
  const observedReward = lp1.capital - lp0.capital + lpFee; // lp.cap_delta + lp.fee_paid
  const insGain = e1.insuranceFund.balance - e0.insuranceFund.balance;

  console.log(`\n  user dt=${userDt} slots  → user_fee = ${userFee}`);
  console.log(`  lp   dt=${lpDt} slots  → lp_fee   = ${lpFee}`);
  console.log(`  total_fees swept          = ${totalFees}`);
  console.log(`  expected reward to LP     = ${expectedReward}`);
  console.log(`  expected insurance gain   = ${expectedInsGain}`);
  console.log(`  observed reward to LP     = ${observedReward}`);
  console.log(`  observed insurance gain   = ${insGain}`);
  console.log(`  observed user capital drop= ${userCapDrop}`);

  check("user lastFeeSlot advanced", u1.lastFeeSlot > u0.lastFeeSlot,
    `before=${u0.lastFeeSlot} after=${u1.lastFeeSlot}`);
  check("lp   lastFeeSlot advanced", lp1.lastFeeSlot > lp0.lastFeeSlot,
    `before=${lp0.lastFeeSlot} after=${lp1.lastFeeSlot}`);
  check("user capital decreased by EXACTLY user_fee", userCapDrop === userFee,
    `drop=${userCapDrop} expected=${userFee}`);
  check("insurance gained EXACTLY 50% of total fees",
    insGain === expectedInsGain,
    `gain=${insGain} expected=${expectedInsGain}`);
  check("keeper (LP) received EXACTLY 50% of total fees as reward",
    observedReward === expectedReward,
    `observed=${observedReward} expected=${expectedReward}`);
  check("LP net capital change = reward − lp_fee",
    lp1.capital - lp0.capital === expectedReward - lpFee,
    `delta=${lp1.capital - lp0.capital} expected=${expectedReward - lpFee}`);
  check("50/50 split: reward == insurance_gain",
    observedReward === insGain);
  check("conservation: cap_delta(user)+cap_delta(lp)+ins_delta = 0",
    (u1.capital - u0.capital) + (lp1.capital - lp0.capital) + insGain === 0n,
    `sum=${(u1.capital - u0.capital) + (lp1.capital - lp0.capital) + insGain}`);
  check("conservation: vault == SPL (fees don't move tokens)", e1.vault === spl1,
    `vault=${e1.vault} SPL=${spl1}`);
  check("accounting: vault >= cTot + insurance",
    e1.vault >= e1.cTot + e1.insuranceFund.balance);

  console.log(`\n════════════════════════════`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
