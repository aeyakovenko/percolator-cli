/**
 * Deploy a credibility-aware LP to an existing market.
 *
 * This script:
 * 1. Creates a matcher context account owned by the credibility matcher program
 * 2. Initializes the context with credibility parameters + LP PDA
 * 3. Initializes the LP in percolator
 * 4. Deposits initial collateral
 *
 * All three initialization steps happen in a single atomic transaction
 * to prevent race conditions.
 *
 * Prerequisites:
 * - The credibility matcher program must already be deployed on-chain
 * - A market slab must exist
 * - The payer must have sufficient SOL for rent + collateral
 *
 * Usage:
 *   npx tsx scripts/deploy-credibility-matcher.ts
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import * as fs from "fs";
import { encodeInitLP, encodeDepositCollateral } from "../src/abi/instructions.js";
import {
  buildAccountMetas,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseUsedIndices } from "../src/solana/slab.js";
import { deriveLpPda } from "../src/solana/pda.js";

// ---------------------------------------------------------------------------
// Configuration — edit these for your deployment
// ---------------------------------------------------------------------------

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);

// The credibility matcher program ID — replace after deployment
const CREDIBILITY_MATCHER_ID = new PublicKey(
  process.env.CREDIBILITY_MATCHER_ID || marketInfo.credibilityMatcherId || PublicKey.default.toBase58()
);

const MATCHER_CTX_SIZE = 320;

// Credibility matcher parameters
const KIND_CREDIBILITY = 2;
const BASE_FEE_BPS = 5; // 0.05% base fee
const MIN_SPREAD_BPS = 10; // 0.10% minimum spread
const MAX_SPREAD_BPS = 200; // 2% maximum spread
const IMBALANCE_K_BPS = 100; // Impact multiplier
const LIQUIDITY_NOTIONAL_E6 = 10_000_000_000_000n; // 10M notional
const MAX_FILL_ABS = 1_000_000_000_000n; // Max fill per trade
const MAX_INVENTORY_ABS = 0n; // 0 = unlimited
const AGE_HALFLIFE_SLOTS = 2_160_000; // ~10 days at 400ms/slot
const INSURANCE_WEIGHT_BPS = 50; // 50 bps max discount from insurance coverage

const LP_COLLATERAL = 5_000_000_000n; // 5 SOL

// ---------------------------------------------------------------------------

const conn = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  "confirmed"
);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")
    )
  )
);

/**
 * Encode credibility matcher init instruction (tag 0x02, 74 bytes)
 */
function encodeInitCredibility(params: {
  kind: number;
  baseFeeBps: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  imbalanceKBps: number;
  liquidityE6: bigint;
  maxFillAbs: bigint;
  maxInventoryAbs: bigint;
  ageHalflifeSlots: number;
  insuranceWeightBps: number;
}): Buffer {
  const data = Buffer.alloc(74);
  let offset = 0;

  data.writeUInt8(0x02, offset); offset += 1; // Tag
  data.writeUInt8(params.kind, offset); offset += 1;
  data.writeUInt32LE(params.baseFeeBps, offset); offset += 4;
  data.writeUInt32LE(params.minSpreadBps, offset); offset += 4;
  data.writeUInt32LE(params.maxSpreadBps, offset); offset += 4;
  data.writeUInt32LE(params.imbalanceKBps, offset); offset += 4;

  // u128 fields
  const liq = params.liquidityE6;
  data.writeBigUInt64LE(liq & 0xFFFF_FFFF_FFFF_FFFFn, offset); offset += 8;
  data.writeBigUInt64LE(liq >> 64n, offset); offset += 8;

  const maxFill = params.maxFillAbs;
  data.writeBigUInt64LE(maxFill & 0xFFFF_FFFF_FFFF_FFFFn, offset); offset += 8;
  data.writeBigUInt64LE(maxFill >> 64n, offset); offset += 8;

  const maxInv = params.maxInventoryAbs;
  data.writeBigUInt64LE(maxInv & 0xFFFF_FFFF_FFFF_FFFFn, offset); offset += 8;
  data.writeBigUInt64LE(maxInv >> 64n, offset); offset += 8;

  data.writeUInt32LE(params.ageHalflifeSlots, offset); offset += 4;
  data.writeUInt32LE(params.insuranceWeightBps, offset);

  return data;
}

async function main() {
  if (CREDIBILITY_MATCHER_ID.equals(PublicKey.default)) {
    console.error("ERROR: Set CREDIBILITY_MATCHER_ID env var or add credibilityMatcherId to devnet-market.json");
    process.exit(1);
  }

  console.log("Deploying Credibility-Aware LP\n");
  console.log("Program:          ", PROGRAM_ID.toBase58());
  console.log("Slab:             ", SLAB.toBase58());
  console.log("Credibility Matcher:", CREDIBILITY_MATCHER_ID.toBase58());
  console.log("");
  console.log("Parameters:");
  console.log("  Base Fee:        ", BASE_FEE_BPS, "bps");
  console.log("  Min Spread:      ", MIN_SPREAD_BPS, "bps");
  console.log("  Max Spread:      ", MAX_SPREAD_BPS, "bps");
  console.log("  Imbalance K:     ", IMBALANCE_K_BPS, "bps");
  console.log("  Age Halflife:    ", AGE_HALFLIFE_SLOTS, "slots (~10 days)");
  console.log("  Insurance Weight:", INSURANCE_WEIGHT_BPS, "bps");
  console.log("");

  // Get wSOL ATA
  const userAta = await getOrCreateAssociatedTokenAccount(
    conn, payer, NATIVE_MINT, payer.publicKey
  );

  // Find next free LP slot
  const slabData = await fetchSlab(conn, SLAB);
  const usedIndices = new Set(parseUsedIndices(slabData));
  let lpIndex = 0;
  while (usedIndices.has(lpIndex)) lpIndex++;
  console.log("LP Index:", lpIndex);

  // Derive LP PDA
  const [lpPda] = deriveLpPda(PROGRAM_ID, SLAB, lpIndex);
  console.log("LP PDA:", lpPda.toBase58());

  // Create matcher context keypair
  const matcherCtxKp = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  console.log("Matcher Context:", matcherCtxKp.publicKey.toBase58());

  // Encode init instruction
  const initData = encodeInitCredibility({
    kind: KIND_CREDIBILITY,
    baseFeeBps: BASE_FEE_BPS,
    minSpreadBps: MIN_SPREAD_BPS,
    maxSpreadBps: MAX_SPREAD_BPS,
    imbalanceKBps: IMBALANCE_K_BPS,
    liquidityE6: LIQUIDITY_NOTIONAL_E6,
    maxFillAbs: MAX_FILL_ABS,
    maxInventoryAbs: MAX_INVENTORY_ABS,
    ageHalflifeSlots: AGE_HALFLIFE_SLOTS,
    insuranceWeightBps: INSURANCE_WEIGHT_BPS,
  });

  // Encode LP init instruction
  const initLpData = encodeInitLP({
    matcherProgram: CREDIBILITY_MATCHER_ID,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: "2000000", // 0.002 SOL
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  // Atomic compound transaction
  console.log("\nCreating credibility LP atomically...");
  const atomicTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    // 1. Create matcher context account
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherRent,
      space: MATCHER_CTX_SIZE,
      programId: CREDIBILITY_MATCHER_ID,
    }),
    // 2. Initialize matcher context with LP PDA and credibility params
    {
      programId: CREDIBILITY_MATCHER_ID,
      keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },
        { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
      ],
      data: initData,
    },
    // 3. Initialize LP in percolator
    buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData })
  );

  await sendAndConfirmTransaction(conn, atomicTx, [payer, matcherCtxKp], {
    commitment: "confirmed",
  });
  console.log("  LP created atomically");

  // Deposit collateral
  console.log(`\nDepositing ${Number(LP_COLLATERAL) / 1e9} SOL collateral...`);
  const depositData = encodeDepositCollateral({
    userIdx: lpIndex,
    amount: LP_COLLATERAL.toString(),
  });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
  ]);
  const depositTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
  );
  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
  console.log("  Deposited");

  console.log("\n========================================");
  console.log("CREDIBILITY LP CREATED");
  console.log("========================================");
  console.log("LP Index:        ", lpIndex);
  console.log("LP PDA:          ", lpPda.toBase58());
  console.log("Matcher Context: ", matcherCtxKp.publicKey.toBase58());
  console.log("Matcher Program: ", CREDIBILITY_MATCHER_ID.toBase58());
  console.log("Collateral:      ", Number(LP_COLLATERAL) / 1e9, "SOL");
  console.log("");
  console.log("Next: Run the credibility update bot to keep snapshots fresh:");
  console.log("  npx tsx scripts/credibility-update-bot.ts");

  // Save to market info
  marketInfo.credibilityLp = {
    index: lpIndex,
    pda: lpPda.toBase58(),
    matcherContext: matcherCtxKp.publicKey.toBase58(),
    matcherProgram: CREDIBILITY_MATCHER_ID.toBase58(),
    collateral: Number(LP_COLLATERAL) / 1e9,
    config: {
      kind: "Credibility",
      baseFeeBps: BASE_FEE_BPS,
      minSpreadBps: MIN_SPREAD_BPS,
      maxSpreadBps: MAX_SPREAD_BPS,
      imbalanceKBps: IMBALANCE_K_BPS,
      ageHalflifeSlots: AGE_HALFLIFE_SLOTS,
      insuranceWeightBps: INSURANCE_WEIGHT_BPS,
    },
  };
  fs.writeFileSync("devnet-market.json", JSON.stringify(marketInfo, null, 2));
  console.log("Updated devnet-market.json");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
