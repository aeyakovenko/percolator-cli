import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";
import { encodeDepositCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);

const LP_INDEX = 8;
const DEPOSIT_AMOUNT = 50_000_000_000n; // 50 SOL

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function main() {
  console.log("Depositing " + Number(DEPOSIT_AMOUNT) / 1e9 + " SOL to LP index " + LP_INDEX + "...");

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  console.log("User ATA:", userAta.address.toBase58());

  // Check balance
  const balance = await conn.getTokenAccountBalance(userAta.address);
  console.log("wSOL balance:", balance.value.uiAmount);

  if (balance.value.uiAmount! < Number(DEPOSIT_AMOUNT) / 1e9) {
    console.log("Need more wSOL! Run sync-wsol.ts first");
    return;
  }

  const depositData = encodeDepositCollateral({
    userIdx: LP_INDEX,
    amount: DEPOSIT_AMOUNT.toString(),
  });

  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  console.log("Deposited:", sig.slice(0, 20) + "...");
}

main().catch(console.error);
