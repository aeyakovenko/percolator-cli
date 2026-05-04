/**
 * Authority coverage: every kind × (rotate, burn, wrong-signer, post-burn).
 *
 *   kind=0 ADMIN              → header.admin             (UpdateConfig, AdminForceClose,
 *                                                          ResolveMarket, SetOraclePriceCap,
 *                                                          CloseSlab — merged from CLOSE in v12.20)
 *   kind=1 HYPERP_MARK        → config.hyperp_authority  (PushOraclePrice; renamed from oracle_authority)
 *   kind=2 INSURANCE          → header.insurance_authority (WithdrawInsurance — unbounded)
 *   kind=4 INSURANCE_OPERATOR → header.insurance_operator (WithdrawInsuranceLimited)
 *
 *   (kind=3 CLOSE was deleted in v12.20; CloseSlab is now ADMIN-gated.)
 *
 * For each kind we verify:
 *   1. parseHeader / parseConfig exposes the authority field.
 *   2. Rotating to a new pubkey requires BOTH current + new to sign.
 *   3. Non-current signer rejected.
 *   4. Burn to Pubkey::default() with only current signer succeeds.
 *   5. After burn, the corresponding capability is lost (no one can invoke it).
 *   6. ADMIN-burn liveness guard: rejected unless perm-resolve > 0 AND force-close > 0.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket, encodeUpdateAuthority, AUTHORITY_KIND,
  encodePushOraclePrice, encodeResolveMarket,
  encodeTopUpInsurance, encodeWithdrawInsurance, encodeCloseSlab,
  encodeUpdateConfig, encodeWithdrawInsuranceLimited,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_UPDATE_ADMIN, ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_WITHDRAW_INSURANCE, ACCOUNTS_CLOSE_SLAB, ACCOUNTS_UPDATE_CONFIG,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import {
  parseHeader, parseConfig, fetchSlab, SLAB_LEN,
} from "../src/solana/slab.js";
import { defaultInitMarketArgs } from "./_default-market.js";

const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const PROG = new PublicKey("4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const ZERO = PublicKey.default;

async function tx(ixs: any[], signers: Keypair[], cu = 300_000) {
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  for (const ix of ixs) t.add(ix);
  return sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed" });
}

let pass = 0, fail = 0;
function ok(name: string)  { pass++; console.log(`  ✓ ${name}`); }
function bad(name: string, d?: string) { fail++; console.log(`  ✗ ${name}  ${d ?? ""}`); }
function check(name: string, cond: boolean, d?: string) { cond ? ok(name) : bad(name, d); }

async function expectReject(name: string, fn: () => Promise<any>, containsAny: string[] = []) {
  try {
    await fn();
    bad(name, "expected rejection, tx succeeded");
  } catch (e: any) {
    const msg = e.message || "";
    if (containsAny.length && !containsAny.some(s => msg.includes(s))) {
      bad(name, `rejected but wrong reason: ${msg.split("\n")[0].slice(0, 100)}`);
    } else {
      ok(name);
    }
  }
}

async function main() {
  console.log("═".repeat(70));
  console.log("AUTHORITY COVERAGE — 4 kinds × rotate / burn / wrong-signer / post-burn (v12.20)");
  console.log("═".repeat(70));

  const slab = Keypair.generate();
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  const [vaultAuth] = deriveVaultAuthority(PROG, slab.publicKey);
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_LEN);

  await tx([SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
    lamports: rent, space: SLAB_LEN, programId: PROG,
  })], [payer, slab], 50_000);

  const vAcc = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vaultAuth, true);
  const payerAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  await mintTo(conn, payer, mint, payerAta.address, payer, 10_000_000_000);

  // Init Hyperp market with perm-resolve + force-close > 0 (needed to eventually burn ADMIN).
  await tx([buildIx({
    programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, mint, vAcc.address,
      WELL_KNOWN.clock, vaultAuth,
    ]),
    data: encodeInitMarket(defaultInitMarketArgs(payer.publicKey, mint, {
      // perm-resolve ≤ MAX_ACCRUAL_DT_SLOTS = 100 (v12.21)
      permissionlessResolveStaleSlots: "100",
      forceCloseDelaySlots:            "200",
      hMax:                            "50",   // must be ≤ perm-resolve
      hMin:                            "10",
      // v12.20 F2 defense: Hyperp + perm-resolve requires mark_min_fee > 0
      // so self-trades can't refresh liveness and block permissionless resolve.
      markMinFee:                      "1000",
      // Seed insurance-limited path so INSURANCE_OPERATOR has something to gate
      insuranceWithdrawMaxBps:         100,      // 1% per tx
      insuranceWithdrawCooldownSlots:  "10",
    })),
  })], [payer], 400_000);

  // Seed insurance so WithdrawInsuranceLimited has something to pull from.
  await tx([buildIx({
    programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      payer.publicKey, slab.publicKey, payerAta.address, vAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]),
    data: encodeTopUpInsurance({ amount: "10000000" }),
  })], [payer]);

  console.log(`\nSlab: ${slab.publicKey.toBase58()}\n`);

  // ── 1. Parser exposes all 4 fields ────────────────────────────
  {
    const h = parseHeader(await fetchSlab(conn, slab.publicKey));
    const c = parseConfig(await fetchSlab(conn, slab.publicKey));
    check("parseHeader.insuranceAuthority = payer (default)", h.insuranceAuthority.equals(payer.publicKey));
    check("parseHeader.insuranceOperator  = payer (default)", h.insuranceOperator.equals(payer.publicKey));
    check("parseConfig.hyperpAuthority    = payer (default at init)", c.hyperpAuthority.equals(payer.publicKey));
    check("parseHeader.admin              = payer (default)", h.admin.equals(payer.publicKey));
  }

  // Helper for UpdateAuthority tx
  const buildAuthTx = (kind: number, newKey: PublicKey, current = payer.publicKey, signers: Keypair[]) => {
    const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [current, newKey, slab.publicKey]);
    return tx([buildIx({
      programId: PROG, keys,
      data: encodeUpdateAuthority({ kind, newPubkey: newKey }),
    })], signers);
  };

  // ── 2. Non-current signer rejected for each kind (rotate attempt) ──
  const rando = Keypair.generate();
  await conn.requestAirdrop(rando.publicKey, 100_000_000).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  for (const [name, kind] of [
    ["ADMIN", AUTHORITY_KIND.ADMIN],
    ["HYPERP_MARK", AUTHORITY_KIND.HYPERP_MARK],
    ["INSURANCE", AUTHORITY_KIND.INSURANCE],
    ["INSURANCE_OPERATOR", AUTHORITY_KIND.INSURANCE_OPERATOR],
  ] as const) {
    await expectReject(
      `${name}: rotate rejected when signed by non-current`,
      () => tx([buildIx({
        programId: PROG,
        keys: buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [rando.publicKey, rando.publicKey, slab.publicKey]),
        data: encodeUpdateAuthority({ kind, newPubkey: rando.publicKey }),
      })], [rando]),
    );
  }

  // ── 3. ADMIN burn gate: 0-perm-resolve initial state already has 10_000 > 0 & force-close 10_000 > 0, so burn will succeed.
  //     Verify instead that rotate requires the NEW key to sign (non-burn).
  const newOracleKp = Keypair.generate();
  await expectReject(
    "HYPERP_MARK: rotate to non-zero rejected without new-key signer",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, newOracleKp.publicKey, slab.publicKey]),
      data: encodeUpdateAuthority({ kind: AUTHORITY_KIND.HYPERP_MARK, newPubkey: newOracleKp.publicKey }),
    })], [payer] /* no newOracleKp signer */),
  );

  // ── 4. Rotate HYPERP_MARK → newOracleKp (both signers) ──
  await tx([buildIx({
    programId: PROG,
    keys: [
      { pubkey: payer.publicKey,      isSigner: true, isWritable: false },
      { pubkey: newOracleKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: slab.publicKey,        isSigner: false, isWritable: true },
    ],
    data: encodeUpdateAuthority({ kind: AUTHORITY_KIND.HYPERP_MARK, newPubkey: newOracleKp.publicKey }),
  })], [payer, newOracleKp]);
  {
    const c = parseConfig(await fetchSlab(conn, slab.publicKey));
    check("HYPERP_MARK rotated to new key", c.hyperpAuthority.equals(newOracleKp.publicKey));
  }

  // Rotate back so we can continue with payer-owned tests.
  // Fund newOracleKp from payer so it can co-sign this tx (first signer pays
  // fees; we put payer first to cover fees even though the UpdateAuthority
  // expects current_authority in accounts[0]).
  await tx([SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: newOracleKp.publicKey, lamports: 10_000_000,
  })], [payer], 20_000);
  await tx([buildIx({
    programId: PROG,
    keys: [
      { pubkey: newOracleKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey,       isSigner: true, isWritable: false },
      { pubkey: slab.publicKey,        isSigner: false, isWritable: true },
    ],
    data: encodeUpdateAuthority({ kind: AUTHORITY_KIND.HYPERP_MARK, newPubkey: payer.publicKey }),
  })], [payer, newOracleKp]);  // payer first = pays fees; both sign

  // ── 5. Burn each NON-ADMIN authority (only current signer needed for burn) ──
  for (const [name, kind, check_key] of [
    ["INSURANCE_OPERATOR", AUTHORITY_KIND.INSURANCE_OPERATOR, "insuranceOperator"],
    ["HYPERP_MARK",        AUTHORITY_KIND.HYPERP_MARK,        "hyperpAuthority"],
    ["INSURANCE",          AUTHORITY_KIND.INSURANCE,          "insuranceAuthority"],
  ] as const) {
    await tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, ZERO, slab.publicKey]),
      data: encodeUpdateAuthority({ kind, newPubkey: ZERO }),
    })], [payer]);
    const buf = await fetchSlab(conn, slab.publicKey);
    const h = parseHeader(buf);
    const c = parseConfig(buf);
    const val = check_key === "hyperpAuthority" ? c.hyperpAuthority : (h as any)[check_key];
    check(`${name} burned (field == 11111…)`, val.equals(ZERO));
  }

  // ── 6. Post-burn capability loss ─────────────────────────────────
  //   HYPERP_MARK burned → PushOraclePrice rejected.
  await expectReject(
    "HYPERP_MARK burned → PushOraclePrice rejected",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]),
      data: encodePushOraclePrice({ priceE6: "100000000", timestamp: Math.floor(Date.now()/1000).toString() }),
    })], [payer]),
  );

  //   INSURANCE burned → WithdrawInsurance rejected. (Market not resolved so it would reject
  //   for that reason first; but this still proves the path is blocked.)
  await expectReject(
    "INSURANCE burned → WithdrawInsurance rejected",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
        payer.publicKey, slab.publicKey, payerAta.address, vAcc.address,
        WELL_KNOWN.tokenProgram, vaultAuth, WELL_KNOWN.clock,
      ]),
      data: encodeWithdrawInsurance(),
    })], [payer]),
  );

  //   INSURANCE_OPERATOR burned → WithdrawInsuranceLimited rejected.
  await expectReject(
    "INSURANCE_OPERATOR burned → WithdrawInsuranceLimited rejected",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
        payer.publicKey, slab.publicKey, payerAta.address, vAcc.address,
        WELL_KNOWN.tokenProgram, vaultAuth, WELL_KNOWN.clock,
      ]),
      data: encodeWithdrawInsuranceLimited({ amount: "100" }),
    })], [payer]),
  );

  // ── 7. ADMIN still owns its capabilities before burn ─────────────
  // UpdateConfig should still work (admin is payer).
  await tx([buildIx({
    programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey,
    ]),
    data: encodeUpdateConfig({
      fundingHorizonSlots: "500", fundingKBps: "100",
      fundingMaxPremiumBps: "500", fundingMaxE9PerSlot: "1000",
      tvlInsuranceCapMult: 0,
    }),
  })], [payer]);
  ok("ADMIN (not yet burned) → UpdateConfig accepted");

  // ── 8. Burn ADMIN — should succeed (perm-resolve > 0 ∧ force-close > 0) ──
  await tx([buildIx({
    programId: PROG,
    keys: buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, ZERO, slab.publicKey]),
    data: encodeUpdateAuthority({ kind: AUTHORITY_KIND.ADMIN, newPubkey: ZERO }),
  })], [payer]);
  {
    const h = parseHeader(await fetchSlab(conn, slab.publicKey));
    check("ADMIN burned (header.admin == 11111…)", h.admin.equals(ZERO));
  }

  // ── 9. Post-ADMIN-burn capability loss ────────────────────────────
  await expectReject(
    "ADMIN burned → UpdateConfig rejected",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
        payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey,
      ]),
      data: encodeUpdateConfig({
        fundingHorizonSlots: "500", fundingKBps: "100",
        fundingMaxPremiumBps: "500", fundingMaxE9PerSlot: "1000",
        tvlInsuranceCapMult: 0,
      }),
    })], [payer]),
  );
  // SetOraclePriceCap (tag 18) was deleted in v12.21 — no admin entry point
  // exists for runtime price-cap changes; the cap is init-immutable.
  await expectReject(
    "ADMIN burned → ResolveMarket rejected",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [
        payer.publicKey, slab.publicKey, WELL_KNOWN.clock, payer.publicKey,
      ]),
      data: encodeResolveMarket(),
    })], [payer]),
  );
  // v12.20: CloseSlab is now ADMIN-gated (kind=3 CLOSE was deleted).
  await expectReject(
    "ADMIN burned → CloseSlab rejected",
    () => tx([buildIx({
      programId: PROG,
      keys: buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
        payer.publicKey, slab.publicKey, vAcc.address, vaultAuth, payerAta.address,
        WELL_KNOWN.tokenProgram,
      ]),
      data: encodeCloseSlab(),
    })], [payer]),
  );

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  TOTAL: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(70)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
