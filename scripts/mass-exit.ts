import { Connection, PublicKey, Keypair, ComputeBudgetProgram, Transaction, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseConfig, parseAllAccounts, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeTradeCpi } from "../src/abi/instructions.js";
import { ACCOUNTS_TRADE_CPI, buildAccountMetas } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";
import path from "path";

// OLD slab has working matcher context configuration
const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const ORACLE = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MATCHER_CTX = new PublicKey("AY7GbUGzEsdQfiPqHuu8H8KAghvxow5KLWHMfHWxqtLM"); // LP 0's matcher
// Try to find LP dynamically
async function findLpIndex(data: Buffer): Promise<number> {
  const indices = parseUsedIndices(data);
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    // LP has non-zero matcher_program
    if (acc.matcherProgram && !acc.matcherProgram.equals(new PublicKey("11111111111111111111111111111111"))) {
      return idx;
    }
  }
  return -1;
}

let LP_IDX = 0; // Test with LP 0

const conn = new Connection("https://api.devnet.solana.com", "confirmed");

// Load wallet
const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));

interface AccountInfo {
  idx: number;
  position: bigint;
  pnl: bigint;
  capital: bigint;
  effectiveEquity: bigint;
}

async function getAccounts(): Promise<AccountInfo[]> {
  const data = await fetchSlab(conn, SLAB);
  const accounts = parseAllAccounts(data);

  return accounts
    .filter(a => a.account.positionSize !== 0n)  // Only accounts with positions
    .map(a => ({
      idx: a.idx,
      position: a.account.positionSize,
      pnl: a.account.pnl,
      capital: a.account.capital,
      effectiveEquity: a.account.capital + (a.account.pnl > 0n ? a.account.pnl : 0n),
    }));
}

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp'), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

async function closePosition(userIdx: number, position: bigint): Promise<boolean> {
  try {
    const data = await fetchSlab(conn, SLAB);

    // To close a position, trade in opposite direction
    const closeSize = -position;  // Negate to close

    console.log(`  Closing position ${position} with trade size ${closeSize}...`);

    // Get LP PDA using correct derivation
    const lpPda = deriveLpPda(SLAB, LP_IDX);

    const ixData = encodeTradeCpi({
      lpIdx: LP_IDX,
      userIdx,
      size: closeSize.toString(),
    });

    // ACCOUNTS_TRADE_CPI order: user, lpOwner, slab, clock, oracle, matcherProg, matcherCtx, lpPda
    const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey,         // user (signer)
      payer.publicKey,         // lpOwner (signer) - same wallet owns LP
      SLAB,                    // slab
      SYSVAR_CLOCK_PUBKEY,     // clock
      ORACLE,                  // oracle
      MATCHER_PROGRAM,         // matcherProg
      MATCHER_CTX,             // matcherCtx
      lpPda,                   // lpPda
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: ixData,
    });

    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 });
    const tx = new Transaction().add(cuIx).add(ix);

    const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
      commitment: "confirmed",
    });

    console.log(`  ✓ Closed: ${sig.slice(0, 20)}...`);
    return true;
  } catch (err: any) {
    console.log(`  ✗ Failed: ${err.message?.slice(0, 200) || err}`);
    // Try to extract logs
    if (err.logs) {
      console.log(`  Logs: ${err.logs.slice(-5).join('\n        ')}`);
    }
    return false;
  }
}

async function main() {
  console.log("=== MASS EXIT - Bank Run Test ===\n");

  // Use LP index 8 which has the correct matcher context
  console.log(`Using LP at index ${LP_IDX}\n`);

  // Get all accounts with positions
  let accounts = await getAccounts();

  if (accounts.length === 0) {
    console.log("No accounts with open positions.");
    return;
  }

  console.log(`Found ${accounts.length} accounts with positions:\n`);

  // Sort by PnL descending (positive first)
  accounts.sort((a, b) => {
    if (a.pnl > b.pnl) return -1;
    if (a.pnl < b.pnl) return 1;
    return 0;
  });

  for (const acc of accounts) {
    const dir = acc.position > 0n ? "LONG" : "SHORT";
    const pnlSol = Number(acc.pnl) / 1e9;
    console.log(`  Account ${acc.idx}: ${dir} ${acc.position}, PnL: ${pnlSol.toFixed(2)} SOL`);
  }

  console.log("\n--- Closing Positive PnL First ---\n");

  const positiveAccounts = accounts.filter(a => a.pnl > 0n);
  const negativeAccounts = accounts.filter(a => a.pnl <= 0n);

  let successCount = 0;
  let failCount = 0;

  // Close positive PnL accounts first
  for (const acc of positiveAccounts) {
    console.log(`Account ${acc.idx} (PnL: ${Number(acc.pnl) / 1e9} SOL):`);
    const success = await closePosition(acc.idx, acc.position);
    if (success) successCount++; else failCount++;
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }

  console.log("\n--- Closing Negative/Zero PnL ---\n");

  // Close negative PnL accounts
  for (const acc of negativeAccounts) {
    console.log(`Account ${acc.idx} (PnL: ${Number(acc.pnl) / 1e9} SOL):`);
    const success = await closePosition(acc.idx, acc.position);
    if (success) successCount++; else failCount++;
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }

  console.log("\n=== RESULTS ===");
  console.log(`Successful closes: ${successCount}`);
  console.log(`Failed closes: ${failCount}`);

  // Check final state
  console.log("\n--- Final State ---");
  const finalData = await fetchSlab(conn, SLAB);
  const engine = parseEngine(finalData);
  console.log(`Vault: ${Number(engine.vault) / 1e9} SOL`);
  console.log(`Insurance: ${Number(engine.insuranceFund.balance) / 1e9} SOL`);
  console.log(`Lifetime Liquidations: ${engine.lifetimeLiquidations}`);
  console.log(`Lifetime Force Closes: ${engine.lifetimeForceCloses}`);
}

main().catch(console.error);
