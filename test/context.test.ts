import { createReadOnlyContext } from "../src/runtime/context.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing runtime contexts...\n");

{
  const ctx = createReadOnlyContext({
    rpcUrl: "https://api.devnet.solana.com",
    programId: "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp",
    wallet: "/path/that/should/not/be/read.json",
    commitment: "confirmed",
  });

  assert(ctx.programId.toBase58() === "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp", "program ID parsed");
  assert(ctx.commitment === "confirmed", "commitment preserved");
  assert(!("payer" in ctx), "read-only context has no payer");

  console.log("✓ createReadOnlyContext does not require a wallet file");
}

console.log("\n✅ All context tests passed!");
