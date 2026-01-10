import { Connection, PublicKey } from "@solana/web3.js";
import { parseUsedIndices, parseAccount } from "../src/solana/slab.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const slab = new PublicKey("9kcSAbQPzqui1uDt7iZAYHmrUB4bVfnAr4UZPmWMc91T");
const ENGINE_OFF = 216;
const ENGINE_ACCOUNTS_OFF = 91160;
const ACCOUNT_SIZE = 248;

async function main() {
  const info = await connection.getAccountInfo(slab);
  if (!info) { console.log("Not found"); return; }

  // Parse all accounts
  const indices = parseUsedIndices(info.data);
  console.log("Used indices:", indices);

  for (const idx of indices) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    const account = parseAccount(info.data, idx);
    console.log("\nAccount", idx + ":");
    console.log("  kind byte @24:", info.data[base + 24], "(0=User, 1=LP)");
    console.log("  Parsed kind:", account.kind === 1 ? "LP" : "User");
    console.log("  Capital:", Number(account.capital) / 1e6, "tokens");
    console.log("  Owner:", account.owner.toBase58());
    console.log("  Matcher program:", account.matcherProgram.toBase58());
    console.log("  Warmup started:", Number(account.warmupStartedAtSlot));
  }

}
main().catch(console.error);
