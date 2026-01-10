import { Connection, PublicKey } from "@solana/web3.js";
import { parseAccount, parseUsedIndices, parseAllAccounts } from "../src/solana/slab.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const slab = new PublicKey("9kcSAbQPzqui1uDt7iZAYHmrUB4bVfnAr4UZPmWMc91T");

async function main() {
  const info = await connection.getAccountInfo(slab);
  if (!info) {
    console.log("Slab not found");
    return;
  }

  // Get all used indices
  const indices = parseUsedIndices(info.data);
  console.log("Used indices:", indices);

  // Parse all accounts
  const accounts = parseAllAccounts(info.data);
  for (const { idx, account } of accounts) {
    console.log(`\nAccount ${idx}:`);
    console.log("  Owner:", account.owner.toBase58());
    console.log("  Kind:", account.kind === 1 ? "LP" : "User");
    console.log("  Position:", account.positionSize.toString());
    console.log("  Capital:", Number(account.capital) / 1e6, "tokens");
    if (account.kind === 1) {
      console.log("  Matcher Program:", account.matcherProgram.toBase58());
    }
  }

  // Expected owner
  console.log("\n\nExpected LP owner: A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK");
}

main().catch(console.error);
