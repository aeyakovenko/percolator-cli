/**
 * Burn the four market authorities on the bounty 2 mainnet market.
 *
 * Run AFTER:
 *   1. setup-mainnet-bounty2.ts has provisioned the market
 *   2. cron-install has scheduled mainnet-bounty2-tick.ts
 *   3. ≥3 successful ticks have landed (check the JSONL log) — proves
 *      the cranker is operational and the market is in a sane state
 *   4. mainnet-bounty2-market.json values match expectations
 *
 * Order is INSURANCE_OPERATOR → INSURANCE → ADMIN (admin must be last
 * because UpdateAuthority is gated on the existing admin signer).
 *
 * After this script: also burn the program upgrade authority via
 *   solana program set-upgrade-authority --url mainnet-beta \
 *     <PROGRAM_ID> --new-upgrade-authority null
 *
 * Both this script's burns and the upgrade-authority burn are
 * IRREVERSIBLE. Re-run sanity checks before invoking either.
 */

import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import { encodeUpdateAuthority, AUTHORITY_KIND } from "../src/abi/instructions.js";
import { ACCOUNTS_UPDATE_ADMIN, buildAccountMetas } from "../src/abi/accounts.js";
import { fetchSlab, parseHeader, parseConfig } from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";

async function main() {
  const m = JSON.parse(fs.readFileSync("mainnet-bounty2-market.json", "utf8"));
  const programId = new PublicKey(m.programId);
  const slab = new PublicKey(m.slab);

  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")
  )));

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("BURN MAINNET BOUNTY 2 AUTHORITIES");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`program: ${programId.toBase58()}`);
  console.log(`slab:    ${slab.toBase58()}`);
  console.log(`payer:   ${payer.publicKey.toBase58()}`);
  console.log("");

  // Sanity: confirm the current authorities are actually payer (not already burned / rotated).
  const buf = await fetchSlab(conn, slab);
  const h = parseHeader(buf);
  const c = parseConfig(buf);
  const ZERO = PublicKey.default;
  const status = (pk: PublicKey) =>
    pk.equals(ZERO) ? "🔥 already burned" :
    pk.equals(payer.publicKey) ? "payer (will burn)" :
    `${pk.toBase58()} (NOT payer — abort)`;
  console.log("current authorities:");
  console.log(`  admin:              ${status(h.admin)}`);
  console.log(`  hyperp_authority:   ${status(c.hyperpAuthority)}`);
  console.log(`  insurance_auth:     ${status(h.insuranceAuthority)}`);
  console.log(`  insurance_operator: ${status(h.insuranceOperator)}`);
  for (const pk of [h.admin, h.insuranceAuthority, h.insuranceOperator]) {
    if (!pk.equals(ZERO) && !pk.equals(payer.publicKey)) {
      throw new Error(
        "An authority is set to a third party — aborting. Manually rotate first."
      );
    }
  }

  const withPriority = (units: number) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ];

  for (const [name, kind, current] of [
    ["INSURANCE_OPERATOR", AUTHORITY_KIND.INSURANCE_OPERATOR, h.insuranceOperator],
    ["INSURANCE",          AUTHORITY_KIND.INSURANCE,          h.insuranceAuthority],
    ["ADMIN",              AUTHORITY_KIND.ADMIN,              h.admin],
  ] as const) {
    if (current.equals(ZERO)) {
      console.log(`✓ ${name} already burned, skipping`);
      continue;
    }
    const t = new Transaction()
      .add(...withPriority(60_000))
      .add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, ZERO, slab]),
        data: encodeUpdateAuthority({ kind, newPubkey: ZERO }),
      }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`✓ ${name} burned  (sig ${sig.slice(0, 16)}…)`);
  }

  // Final state.
  const finalBuf = await fetchSlab(conn, slab);
  const fh = parseHeader(finalBuf);
  const fc = parseConfig(finalBuf);
  console.log("\nfinal state:");
  console.log(`  admin:              ${fh.admin.equals(ZERO) ? "🔥" : fh.admin.toBase58()}`);
  console.log(`  hyperp_authority:   ${fc.hyperpAuthority.equals(ZERO) ? "🔥" : fc.hyperpAuthority.toBase58()}`);
  console.log(`  insurance_auth:     ${fh.insuranceAuthority.equals(ZERO) ? "🔥" : fh.insuranceAuthority.toBase58()}`);
  console.log(`  insurance_operator: ${fh.insuranceOperator.equals(ZERO) ? "🔥" : fh.insuranceOperator.toBase58()}`);

  // Update manifest.
  m.admin = "🔥 BURNED";
  m.insuranceAuthority = "🔥 BURNED";
  m.insuranceOperator = "🔥 BURNED";
  m.hyperpAuthority = fc.hyperpAuthority.equals(ZERO) ? "🔥 BURNED (auto for non-Hyperp)" : fc.hyperpAuthority.toBase58();
  m.authoritiesBurnedAt = new Date().toISOString();
  fs.writeFileSync("mainnet-bounty2-market.json", JSON.stringify(m, null, 2));

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("All four market authorities burned. Final irreversible step:");
  console.log(`  solana program set-upgrade-authority --url mainnet-beta \\`);
  console.log(`    ${programId.toBase58()} --new-upgrade-authority null`);
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
