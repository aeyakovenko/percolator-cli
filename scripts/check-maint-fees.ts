/**
 * Maintenance-fee keeper-sweep verification.
 *
 * Creates a Hyperp market with a nonzero maintenance_fee_per_slot,
 * materializes one LP + one user, lets slots pass, cranks, and checks
 * that fees flow from user capital → insurance fund through the
 * engine's per-account last_fee_slot cursor.
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

  // Deposit 100M into user
  const DEPOSIT = 100_000_000n;
  await tx([buildIx({ programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, slab.publicKey, payerAta.address, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]),
    data: encodeDepositCollateral({ userIdx: 1, amount: DEPOSIT.toString() }),
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

  console.log(`\n=== Waiting 15s for slot progression, then 3 cranks ===`);
  await new Promise(r => setTimeout(r, 15000));

  for (let i = 0; i < 3; i++) {
    try {
      await tx([buildIx({ programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
          payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
        ]),
        data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
      })], [payer], 400_000);
    } catch (e: any) {
      console.log(`  crank ${i}: ${e.message?.slice(0, 100)}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

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

  const slotsElapsed = Number(e1.currentSlot) - Number(e0.currentSlot);
  const userCapDrop = u0.capital - u1.capital;
  const lpCapDrop = lp0.capital - lp1.capital;
  const insGain = e1.insuranceFund.balance - e0.insuranceFund.balance;

  console.log(`\n  slots elapsed: ${slotsElapsed}`);
  console.log(`  user capital drop: ${userCapDrop}`);
  console.log(`  lp   capital drop: ${lpCapDrop}`);
  console.log(`  insurance gain:    ${insGain}`);

  check("user lastFeeSlot advanced past init", u1.lastFeeSlot > u0.lastFeeSlot,
    `before=${u0.lastFeeSlot} after=${u1.lastFeeSlot}`);
  check("user capital decreased (fees charged)", u1.capital < u0.capital,
    `before=${u0.capital} after=${u1.capital}`);
  check("insurance fund received fees", e1.insuranceFund.balance > e0.insuranceFund.balance,
    `before=${e0.insuranceFund.balance} after=${e1.insuranceFund.balance}`);
  check("fee amount ≥ 1 × slot-rate per charged slot",
    userCapDrop >= BigInt(MAINT_FEE_PER_SLOT),
    `drop=${userCapDrop} rate=${MAINT_FEE_PER_SLOT}`);
  check("conservation: vault == SPL (fees don't move tokens)", e1.vault === spl1,
    `vault=${e1.vault} SPL=${spl1}`);
  check("accounting: vault >= cTot + insurance",
    e1.vault >= e1.cTot + e1.insuranceFund.balance);
  check("total debit = insurance gain", userCapDrop + lpCapDrop === insGain,
    `user=${userCapDrop} + lp=${lpCapDrop} vs insGain=${insGain}`);

  console.log(`\n════════════════════════════`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
