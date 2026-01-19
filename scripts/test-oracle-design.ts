/**
 * Test Oracle Design
 *
 * This script demonstrates how to create a Chainlink-compatible oracle account
 * that could be used for stress testing if the percolator program allowed it.
 *
 * Current limitation: Percolator validates oracle.owner == CHAINLINK_PROGRAM_ID
 *
 * To enable test oracles, the percolator program would need:
 * 1. A `test_oracle_authority` field in MarketConfig
 * 2. Modified oracle validation to skip owner check when test mode enabled
 */
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "fs";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

// Chainlink oracle data layout (248 bytes total)
const ORACLE_SIZE = 248;
const DECIMALS_OFFSET = 138;
const ANSWER_OFFSET = 216;

interface TestOracleState {
  priceUsd: number;
  decimals: number;
}

function createOracleData(state: TestOracleState): Buffer {
  const data = Buffer.alloc(ORACLE_SIZE);

  // Write decimals at offset 138
  data.writeUInt8(state.decimals, DECIMALS_OFFSET);

  // Write price answer at offset 216 (as i64)
  const priceRaw = BigInt(Math.round(state.priceUsd * Math.pow(10, state.decimals)));
  data.writeBigInt64LE(priceRaw, ANSWER_OFFSET);

  return data;
}

function readOracleData(data: Buffer): TestOracleState {
  const decimals = data.readUInt8(DECIMALS_OFFSET);
  const answer = data.readBigInt64LE(ANSWER_OFFSET);
  const priceUsd = Number(answer) / Math.pow(10, decimals);
  return { priceUsd, decimals };
}

async function main() {
  console.log("=== TEST ORACLE DESIGN ===\n");

  // Generate a new keypair for the test oracle
  const oracleKeypair = Keypair.generate();

  console.log("Test Oracle Address:", oracleKeypair.publicKey.toBase58());
  console.log("Authority (payer):", payer.publicKey.toBase58());
  console.log();

  // Create the oracle account
  const initialPrice = 143.50;  // $143.50 SOL
  const oracleData = createOracleData({ priceUsd: initialPrice, decimals: 8 });

  console.log("=== CREATING TEST ORACLE ACCOUNT ===");
  console.log(`Initial price: $${initialPrice}`);
  console.log(`Data size: ${oracleData.length} bytes`);
  console.log(`Decimals at offset ${DECIMALS_OFFSET}:`, oracleData.readUInt8(DECIMALS_OFFSET));
  console.log(`Answer at offset ${ANSWER_OFFSET}:`, oracleData.readBigInt64LE(ANSWER_OFFSET).toString());
  console.log();

  // Calculate rent
  const rentExempt = await conn.getMinimumBalanceForRentExemption(ORACLE_SIZE);
  console.log(`Rent exempt: ${rentExempt / 1e9} SOL`);

  // Create account transaction
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: oracleKeypair.publicKey,
    lamports: rentExempt,
    space: ORACLE_SIZE,
    programId: SystemProgram.programId,  // System-owned, writable by payer
  });

  const tx = new Transaction().add(createAccountIx);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer, oracleKeypair], { commitment: "confirmed" });
    console.log("Account created:", sig);

    // Write initial data directly (only works for system-owned accounts)
    // In reality, we'd need a program to manage this
    console.log("\n⚠️  NOTE: This account is owned by System Program");
    console.log("   Percolator will reject it because owner != Chainlink Program");

  } catch (e: any) {
    console.log("Create failed:", e.message?.slice(0, 100));
  }

  console.log("\n=== PROGRAM CHANGES NEEDED ===\n");

  console.log("To allow test oracles, modify percolator program:\n");

  console.log("1. Add to MarketConfig:");
  console.log("   ```rust");
  console.log("   pub test_oracle_authority: Option<Pubkey>,");
  console.log("   ```\n");

  console.log("2. Add new instruction SetTestOracleAuthority:");
  console.log("   ```rust");
  console.log("   pub fn set_test_oracle_authority(");
  console.log("       ctx: Context<AdminOnly>,");
  console.log("       authority: Option<Pubkey>,");
  console.log("   ) -> Result<()>");
  console.log("   ```\n");

  console.log("3. Modify oracle validation in crank/trade:");
  console.log("   ```rust");
  console.log("   fn validate_oracle(oracle: &AccountInfo, config: &MarketConfig) -> Result<Price> {");
  console.log("       // Skip owner check if test mode enabled");
  console.log("       if config.test_oracle_authority.is_none() {");
  console.log("           require!(oracle.owner == &CHAINLINK_PROGRAM, OracleError::InvalidOwner);");
  console.log("       }");
  console.log("       read_chainlink_format(oracle)");
  console.log("   }");
  console.log("   ```\n");

  console.log("4. Create test oracle management program:");
  console.log("   - init_oracle(authority) -> creates 248-byte account");
  console.log("   - update_price(new_price, decimals) -> writes at correct offsets");
  console.log("   - Authority signs update transactions\n");

  console.log("=== ALTERNATIVE: DEPLOY NEW MARKET ===\n");
  console.log("If you have access to deploy the percolator program:");
  console.log("1. Deploy a simple 'test-oracle' program");
  console.log("2. Initialize account with Chainlink-compatible layout");
  console.log("3. Modify percolator to accept this program as valid oracle owner");
  console.log("4. Deploy modified percolator to devnet");
  console.log("5. Initialize new market pointing to test oracle");

  // Show what stress test scenarios this would enable
  console.log("\n=== STRESS SCENARIOS ENABLED ===\n");

  const scenarios = [
    { name: "Flash crash", priceChange: -50, desc: "SOL drops 50% in one block" },
    { name: "Gradual decline", priceChange: -5, desc: "5% drop per crank cycle" },
    { name: "Pump and dump", priceChange: 100, desc: "100% pump then crash" },
    { name: "Volatility spike", priceChange: 20, desc: "±20% oscillation" },
    { name: "Price to zero", priceChange: -99, desc: "Near-zero price edge case" },
  ];

  console.log("| Scenario        | Price Change | Test Case |");
  console.log("|-----------------|--------------|-----------|");
  for (const s of scenarios) {
    console.log(`| ${s.name.padEnd(15)} | ${(s.priceChange > 0 ? "+" : "") + s.priceChange + "%".padEnd(12)} | ${s.desc} |`);
  }
}

main().catch(console.error);
