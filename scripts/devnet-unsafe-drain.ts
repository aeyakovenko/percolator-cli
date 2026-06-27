/**
 * Devnet mass-drain: iterate every account owned by the wrapper program
 * Bu1J8eQQN…, drain its lamports (and any vault token balance) to admin
 * via the temporarily-deployed `unsafe_forced_close` BPF (tag 0xFF / 0xFE).
 *
 * Tag 0xFF: full drain — vault wSOL + slab rent.
 *   accounts: [destination, dest_token, slab, vault_token, vault_auth, token_program]
 * Tag 0xFE: slab-only drain — when no vault is available.
 *   accounts: [destination, slab]
 *
 * For markets (kind=1) we look up the vault PDA + its NATIVE_MINT ATA;
 * if the ATA exists, tag 0xFF, else tag 0xFE. For all other kinds
 * (portfolios, ledgers) we use tag 0xFE.
 *
 * Runs N=8 in parallel. Best-effort: failures are logged + skipped.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";

const PROG = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const RPC = process.env.SOLANA_RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=2dfa2086-c6cd-4cb4-8a13-08ecdee36a0f";
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const PARALLEL = 8;

const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

function deriveVaultAuth(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROG);
}

const cu = (units = 200_000) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
];

async function drainAccount(acct: PublicKey, kind: number): Promise<{ ok: boolean; tag: string; sol: number; err?: string }> {
  const ai = await conn.getAccountInfo(acct, "confirmed").catch(() => null);
  if (!ai) return { ok: true, tag: "gone", sol: 0 };
  const startSol = ai.lamports / 1e9;

  if (kind === 1) {
    // Try tag 0xFF (full drain) first — look up vault ATA
    const [vaultAuth, bump] = deriveVaultAuth(acct);
    const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
    const vaultInfo = await conn.getAccountInfo(vaultAta, "confirmed").catch(() => null);

    if (vaultInfo) {
      const data = Buffer.from([0xFF, bump]);
      const ix = new TransactionInstruction({
        programId: PROG,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: adminAta, isSigner: false, isWritable: true },
          { pubkey: acct, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
      const tx = new Transaction().add(...cu(), ix);
      try {
        await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: true });
        return { ok: true, tag: "0xFF", sol: startSol };
      } catch (e: any) {
        // Fall through to 0xFE
      }
    }
  }

  // tag 0xFE: slab-only
  const data = Buffer.from([0xFE, 0]);
  const ix = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: acct, isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction().add(...cu(), ix);
  try {
    await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: true });
    return { ok: true, tag: "0xFE", sol: startSol };
  } catch (e: any) {
    return { ok: false, tag: "ERR", sol: 0, err: String(e?.message ?? e).slice(0, 100) };
  }
}

async function runPool<T>(tasks: (() => Promise<T>)[], parallel: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: parallel }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  // Ensure admin wSOL ATA exists for 0xFF drains.
  const adminAtaInfo = await conn.getAccountInfo(adminAta).catch(() => null);
  if (!adminAtaInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
    );
    await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
    console.log("created admin wSOL ATA");
  }

  const balBefore = (await conn.getBalance(admin.publicKey)) / 1e9;
  console.log(`admin balance: ${balBefore} SOL`);

  for (const kind of [1, 2, 3, 4]) {
    const filt = [{ memcmp: { offset: 10, bytes: Buffer.from([kind]).toString("base64"), encoding: "base64" as const } }];
    const accts = await conn.getProgramAccounts(PROG, { commitment: "confirmed", filters: filt });
    console.log(`\n=== kind=${kind}: ${accts.length} accts ===`);
    const tasks = accts.map(({ pubkey }) => () => drainAccount(pubkey, kind));
    const out = await runPool(tasks, PARALLEL);
    const ff = out.filter(r => r.tag === "0xFF").length;
    const fe = out.filter(r => r.tag === "0xFE").length;
    const gone = out.filter(r => r.tag === "gone").length;
    const err = out.filter(r => r.tag === "ERR");
    const solRecovered = out.reduce((s, r) => s + r.sol, 0);
    console.log(`  ✅ 0xFF=${ff}  0xFE=${fe}  gone=${gone}  ERR=${err.length}  ≈${solRecovered.toFixed(4)} SOL`);
    if (err.length && err.length < 10) for (const e of err) console.log(`  ❌ ${e.err}`);
  }

  // Unwrap wSOL → native
  const ataAfter = await conn.getAccountInfo(adminAta).catch(() => null);
  if (ataAfter && ataAfter.lamports > 0) {
    const closeTx = new Transaction().add(createCloseAccountInstruction(adminAta, admin.publicKey, admin.publicKey));
    try {
      await sendAndConfirmTransaction(conn, closeTx, [admin], { commitment: "confirmed", skipPreflight: true });
      console.log("\nclosed wSOL ATA (unwrap to native)");
    } catch {}
  }

  const balAfter = (await conn.getBalance(admin.publicKey)) / 1e9;
  console.log(`\nadmin balance: ${balAfter} SOL  (+${(balAfter - balBefore).toFixed(4)})`);
})();
