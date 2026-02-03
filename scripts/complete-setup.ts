import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  LAMPORTS_PER_SOL, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction,
  ComputeBudgetProgram, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import { parseUsedIndices, parseHeader, parseConfig, parseEngine } from "../src/solana/slab.js";
import {
  encodeInitLP, encodeDepositCollateral, encodeTopUpInsurance,
  encodeSetOracleAuthority, encodePushOraclePrice,
  encodeSetOraclePriceCap,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_LP, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
} from "../src/abi/accounts.js";
import { deriveLpPda } from "../src/solana/pda.js";

const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MATCHER_CTX_SIZE = 320;
const CHAINLINK_SOL_USD = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");

// New slab from setup step (already initialized)
const SLAB = new PublicKey("WzwZMuQq4SpJVYCLwpR1mN98eZW4ntZFkq9K2obWYLr");
const VAULT = new PublicKey("6DfS9bRdXYkvM4Aod7GNebLrcfefu8ZtBrGRNE3FCjUh");
const VAULT_PDA = new PublicKey("EkeVFG4XNPKRvjbjnBgPRcp3fZfdoCZKxvCozGiEo8Dt");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function buildIx(p: { programId: PublicKey; keys: any[]; data: Buffer }): TransactionInstruction {
  return new TransactionInstruction(p);
}

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")))
  );
  console.log("Balance:", (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");

  // Step 1: Create admin ATA and wrap SOL
  console.log("\n1. Creating admin ATA and wrapping SOL...");
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, MINT, payer.publicKey);
  const wrapAmount = 2 * LAMPORTS_PER_SOL;
  const wrapTx = new Transaction();
  wrapTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  wrapTx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: adminAta.address, lamports: wrapAmount }));
  wrapTx.add({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: adminAta.address, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
  await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  console.log("   Wrapped 2 SOL");

  // Step 2: Create matcher context
  console.log("\n2. Creating matcher context...");
  const matcherCtxKp = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const createMatcherTx = new Transaction();
  createMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  createMatcherTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: matcherCtxKp.publicKey,
    lamports: matcherRent, space: MATCHER_CTX_SIZE, programId: MATCHER_PROGRAM_ID,
  }));
  await sendAndConfirmTransaction(conn, createMatcherTx, [payer, matcherCtxKp], { commitment: "confirmed" });
  console.log("   Matcher ctx:", matcherCtxKp.publicKey.toBase58());

  // Step 3: Init matcher context + LP
  const lpIndex = 0;
  const [lpPda] = deriveLpPda(PROGRAM_ID, SLAB, lpIndex);
  console.log("   LP PDA:", lpPda.toBase58());

  const initMatcherTx = new Transaction();
  initMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initMatcherTx.add({ programId: MATCHER_PROGRAM_ID, keys: [
    { pubkey: lpPda, isSigner: false, isWritable: false },
    { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
  ], data: Buffer.from([1]) });
  await sendAndConfirmTransaction(conn, initMatcherTx, [payer], { commitment: "confirmed" });

  console.log("\n3. Initializing LP...");
  const initLpData = encodeInitLP({ matcherProgram: MATCHER_PROGRAM_ID, matcherContext: matcherCtxKp.publicKey, feePayment: "2000000" });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, SLAB, adminAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const initLpTx = new Transaction();
  initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initLpTx.add(buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }));
  await sendAndConfirmTransaction(conn, initLpTx, [payer], { commitment: "confirmed" });
  console.log("   LP initialized at index", lpIndex);

  // Step 4: Deposit to LP
  console.log("\n4. Depositing 0.5 SOL to LP...");
  const lpDeposit = 500_000_000n;
  const depositData = encodeDepositCollateral({ userIdx: lpIndex, amount: lpDeposit.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, SLAB, adminAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]);
  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
  console.log("   Deposited 0.5 SOL");

  // Step 5: Top up insurance
  console.log("\n5. Topping up insurance with 0.5 SOL...");
  const insAmount = 500_000_000n;
  const topupData = encodeTopUpInsurance({ amount: insAmount.toString() });
  const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, SLAB, adminAta.address, VAULT, TOKEN_PROGRAM_ID]);
  const topupTx = new Transaction();
  topupTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  topupTx.add(buildIx({ programId: PROGRAM_ID, keys: topupKeys, data: topupData }));
  await sendAndConfirmTransaction(conn, topupTx, [payer], { commitment: "confirmed" });
  console.log("   Insurance funded");

  // Step 6: Set oracle authority (self) and push initial price
  console.log("\n6. Setting oracle authority...");
  const setAuthData = encodeSetOracleAuthority({ newAuthority: payer.publicKey });
  const setAuthTx = new Transaction();
  setAuthTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  setAuthTx.add(buildIx({ programId: PROGRAM_ID, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: SLAB, isSigner: false, isWritable: true },
  ], data: setAuthData }));
  await sendAndConfirmTransaction(conn, setAuthTx, [payer], { commitment: "confirmed" });
  console.log("   Oracle authority set to admin");

  // Push initial price (inverted: 1/SOL * 1e6, e.g. for $100 SOL → price = 10000)
  const priceE6 = 10000n;  // ~$100 SOL inverted
  const pushData = encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: (BigInt(Math.floor(Date.now() / 1000))).toString() });
  const pushTx = new Transaction();
  pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  pushTx.add(buildIx({ programId: PROGRAM_ID, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: SLAB, isSigner: false, isWritable: true },
  ], data: pushData }));
  await sendAndConfirmTransaction(conn, pushTx, [payer], { commitment: "confirmed" });
  console.log("   Pushed initial price:", priceE6.toString());

  // Step 7: Set oracle price cap (10% = 100_000 e2bps)
  console.log("\n7. Setting oracle price cap (10%)...");
  const setCapData = encodeSetOraclePriceCap({ maxChangeE2bps: "100000" });
  const setCapTx = new Transaction();
  setCapTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  setCapTx.add(buildIx({ programId: PROGRAM_ID, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: SLAB, isSigner: false, isWritable: true },
  ], data: setCapData }));
  await sendAndConfirmTransaction(conn, setCapTx, [payer], { commitment: "confirmed" });
  console.log("   Price cap set to 10% per update");

  // Verify
  console.log("\n8. Verifying...");
  const slabInfo = await conn.getAccountInfo(SLAB);
  if (slabInfo) {
    const header = parseHeader(slabInfo.data as Buffer);
    const config = parseConfig(slabInfo.data as Buffer);
    const engine = parseEngine(slabInfo.data as Buffer);
    console.log("   Admin:", header.admin.toBase58());
    console.log("   Inverted:", config.invert === 1);
    console.log("   Oracle cap:", config.oraclePriceCapE2bps.toString(), "e2bps");
    console.log("   Last eff price:", config.lastEffectivePriceE6.toString());
    console.log("   Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
    console.log("   C_tot:", Number(engine.cTot) / 1e9, "SOL");
  }

  // Write market info
  const marketInfo = {
    network: "devnet",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
    slab: SLAB.toBase58(),
    mint: MINT.toBase58(),
    vault: VAULT.toBase58(),
    vaultPda: VAULT_PDA.toBase58(),
    oracle: CHAINLINK_SOL_USD.toBase58(),
    oracleType: "chainlink",
    inverted: true,
    lp: { index: lpIndex, pda: lpPda.toBase58(), matcherContext: matcherCtxKp.publicKey.toBase58(), collateral: 0.5 },
    insuranceFund: 0.5,
    admin: payer.publicKey.toBase58(),
    adminAta: adminAta.address.toBase58(),
  };
  fs.writeFileSync("devnet-market.json", JSON.stringify(marketInfo, null, 2));
  console.log("\nSaved devnet-market.json");
  console.log("Balance:", (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");
}
main().catch(console.error);
