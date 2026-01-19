import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine } from "../src/solana/slab.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_IDX = marketInfo.lp.index;

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function runCrank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
}

async function runSweepCycle(): Promise<void> {
  console.log("Running sweep cycle...");
  for (let i = 0; i < 20; i++) {
    try {
      await runCrank();
      const data = await fetchSlab(conn, SLAB);
      const engine = parseEngine(data);
      const slot = await conn.getSlot();
      if (slot - Number(engine.lastSweepStartSlot) <= Number(engine.maxCrankStalenessSlots)) {
        console.log("Sweep is fresh at step", engine.crankStep);
        return;
      }
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

async function createUser(userAta: PublicKey): Promise<number> {
  // Get current indices
  const beforeData = await fetchSlab(conn, SLAB);
  const beforeIndices = parseUsedIndices(beforeData);

  // Init user
  const initData = encodeInitUser({ feePayment: "2000000" });
  const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    payer.publicKey,
    SLAB,
    userAta,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
  await sendAndConfirmTransaction(conn, initTx, [payer], { commitment: "confirmed" });

  // Find new index
  const afterData = await fetchSlab(conn, SLAB);
  const afterIndices = parseUsedIndices(afterData);
  const newIdx = afterIndices.find(i => !beforeIndices.includes(i));
  return newIdx || -1;
}

async function depositToUser(userIdx: number, amount: bigint, userAta: PublicKey): Promise<void> {
  const depositData = encodeDepositCollateral({ userIdx, amount: amount.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
}

async function tradeUser(userIdx: number, size: bigint): Promise<void> {
  const lpPda = deriveLpPda(SLAB, LP_IDX);
  const tradeData = encodeTradeCpi({
    lpIdx: LP_IDX,
    userIdx,
    size: size.toString(),
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
    MATCHER_PROGRAM,
    MATCHER_CTX,
    lpPda,
  ]);

  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeTx }));
  await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
}

async function main() {
  console.log("=== Setup Traders for Bank Run Test ===\n");
  console.log("Slab:", SLAB.toBase58());
  console.log("LP:", LP_IDX, "PDA:", deriveLpPda(SLAB, LP_IDX).toBase58());
  console.log("Matcher ctx:", MATCHER_CTX.toBase58());
  console.log("");

  // Get user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  // Ensure wSOL balance
  const balance = await conn.getTokenAccountBalance(userAta.address);
  if (balance.value.uiAmount! < 5) {
    console.log("Wrapping 5 SOL...");
    const wrapTx = new Transaction();
    wrapTx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userAta.address,
      lamports: 5_000_000_000,
    }));
    wrapTx.add({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: userAta.address, isSigner: false, isWritable: true }],
      data: Buffer.from([17]),
    });
    await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  }

  // Run sweep cycle to ensure crank is fresh
  await runSweepCycle();

  // Find existing user accounts
  const data = await fetchSlab(conn, SLAB);
  const indices = parseUsedIndices(data);
  console.log("\nUsed indices:", indices);

  // Find user accounts (non-LP)
  const users: number[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey)) {
      users.push(idx);
    }
  }
  console.log("Existing user accounts:", users);

  // Create more users if needed (target: 5 users)
  const targetUsers = 5;
  const additionalNeeded = targetUsers - users.length;

  if (additionalNeeded > 0) {
    console.log("\nCreating " + additionalNeeded + " new users...");
    for (let i = 0; i < additionalNeeded; i++) {
      try {
        const newIdx = await createUser(userAta.address);
        if (newIdx >= 0) {
          users.push(newIdx);
          console.log("Created user at index", newIdx);
        }
      } catch (err) {
        console.log("Failed to create user:", (err as any).message?.slice(0, 50));
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Deposit and trade for each user
  console.log("\nSetting up positions for users:", users);
  const lpPda = deriveLpPda(SLAB, LP_IDX);

  for (let i = 0; i < users.length; i++) {
    const userIdx = users[i];
    const direction = i % 2 === 0 ? 1n : -1n; // Alternate long/short
    const size = direction * 500_000_000n; // 500M units

    try {
      // Run sweep
      await runSweepCycle();

      // Check capital
      const slabData = await fetchSlab(conn, SLAB);
      const acc = parseAccount(slabData, userIdx);
      
      // Deposit if needed
      if (acc.capital < 500_000_000n) {
        console.log("Depositing 1 SOL to user", userIdx);
        await depositToUser(userIdx, 1_000_000_000n, userAta.address);
        await new Promise(r => setTimeout(r, 500));
      }

      // Trade if no position
      if (acc.positionSize === 0n) {
        console.log("User " + userIdx + " going " + (direction > 0n ? "LONG" : "SHORT") + " " + size);
        
        const tradeData = encodeTradeCpi({
          lpIdx: LP_IDX,
          userIdx,
          size: size.toString(),
        });

        const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
          payer.publicKey,
          payer.publicKey,
          SLAB,
          SYSVAR_CLOCK_PUBKEY,
          ORACLE,
          MATCHER_PROGRAM,
          MATCHER_CTX,
          lpPda,
        ]);

        const tradeTx = new Transaction();
        tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
        tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
        await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
        console.log("Trade successful for user", userIdx);
      } else {
        console.log("User", userIdx, "already has position:", acc.positionSize.toString());
      }
    } catch (err) {
      console.log("Error with user", userIdx + ":", (err as any).message?.slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Final state
  console.log("\n=== Final State ===");
  const finalData = await fetchSlab(conn, SLAB);
  const engine = parseEngine(finalData);
  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  for (const userIdx of users) {
    const acc = parseAccount(finalData, userIdx);
    const dir = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";
    console.log("User " + userIdx + ": " + dir + " " + acc.positionSize + ", capital: " + (Number(acc.capital) / 1e9).toFixed(2) + " SOL");
  }
}

main().catch(console.error);
