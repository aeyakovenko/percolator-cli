import { PublicKey } from "@solana/web3.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing PDA derivations...\n");

// Test deriveVaultAuthority
{
  const programId = PublicKey.unique();
  const slab = PublicKey.unique();

  const [pda, bump] = deriveVaultAuthority(programId, slab);

  assert(pda instanceof PublicKey, "vault authority is PublicKey");
  assert(typeof bump === "number", "bump is number");
  assert(bump >= 0 && bump <= 255, "bump in valid range");

  // Verify it's deterministic
  const [pda2, bump2] = deriveVaultAuthority(programId, slab);
  assert(pda.equals(pda2), "vault authority deterministic");
  assert(bump === bump2, "bump deterministic");

  // Verify PDA is off curve
  assert(!PublicKey.isOnCurve(pda.toBytes()), "vault authority is off curve");

  console.log("✓ deriveVaultAuthority");
}

// Test deriveLpPda
{
  const programId = PublicKey.unique();
  const slab = PublicKey.unique();

  const [pda0, bump0] = deriveLpPda(programId, slab, 0);
  const [pda1, bump1] = deriveLpPda(programId, slab, 1);
  const [pda100, bump100] = deriveLpPda(programId, slab, 100);

  assert(pda0 instanceof PublicKey, "lp pda 0 is PublicKey");
  assert(pda1 instanceof PublicKey, "lp pda 1 is PublicKey");
  assert(pda100 instanceof PublicKey, "lp pda 100 is PublicKey");

  // Different indices should produce different PDAs
  assert(!pda0.equals(pda1), "lp pda 0 != lp pda 1");
  assert(!pda0.equals(pda100), "lp pda 0 != lp pda 100");
  assert(!pda1.equals(pda100), "lp pda 1 != lp pda 100");

  // Verify deterministic
  const [pda0b] = deriveLpPda(programId, slab, 0);
  assert(pda0.equals(pda0b), "lp pda deterministic");

  // Verify off curve
  assert(!PublicKey.isOnCurve(pda0.toBytes()), "lp pda is off curve");

  console.log("✓ deriveLpPda");
}

// Test that vault and LP PDAs are different
{
  const programId = PublicKey.unique();
  const slab = PublicKey.unique();

  const [vaultPda] = deriveVaultAuthority(programId, slab);
  const [lpPda] = deriveLpPda(programId, slab, 0);

  assert(!vaultPda.equals(lpPda), "vault pda != lp pda");

  console.log("✓ vault and LP PDAs are distinct");
}

console.log("\n✅ All PDA tests passed!");
