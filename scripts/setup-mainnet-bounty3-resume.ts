/**
 * Resume bounty-3 setup at step 7 (UpdateConfig with tvlInsuranceCapMult=50)
 * after CU-meter failure on first attempt. Steps 1-6 already on chain.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeUpdateConfig, encodeKeeperCrank,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_UPDATE_CONFIG, ACCOUNTS_KEEPER_CRANK, buildAccountMetas,
} from "../src/abi/accounts.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, SLAB_LEN } from "../src/solana/slab.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import { buildIx } from "../src/runtime/tx.js";

const PROGRAM_ID = new PublicKey("2LfCFmDKwcnHunqdsCW9uV7KNgBgnFGASs8uM7MwHgHm");
const SLAB_PUBKEY = new PublicKey("zExGagF9FeMTYGjvkBhknmNzLAP7toX6Aj6Pu1kuvmT");
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")
  )));

  console.log("Resume bounty-3 setup at step 7");
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);

  const withPriority = (units: number) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ];

  const crankIx = () => buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, SLAB_PUBKEY, CLOCK_SYSVAR, PYTH_SOL_USD,
    ]),
    data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
  });

  // Pre-state
  const preBuf = await fetchSlab(conn, SLAB_PUBKEY);
  const preCfg = parseConfig(preBuf);
  console.log(`pre tvlInsuranceCapMult: ${preCfg.tvlInsuranceCapMult}`);

  if (preCfg.tvlInsuranceCapMult !== 50) {
    console.log("\n[7] UpdateConfig: tvlInsuranceCapMult = 50...");
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(crankIx())
      .add(buildIx({
        programId: PROGRAM_ID,
        keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
          payer.publicKey, SLAB_PUBKEY, CLOCK_SYSVAR, PYTH_SOL_USD,
        ]),
        data: encodeUpdateConfig({
          fundingHorizonSlots:  "7200",
          fundingKBps:          "100",
          fundingMaxPremiumBps: "500",
          fundingMaxE9PerSlot:  "1000",
          tvlInsuranceCapMult:  50,
        }),
      }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    sig: ${sig.slice(0, 40)}...`);
  } else {
    console.log("    (already at 50, skipping)");
  }

  // Verify final state
  const buf = await fetchSlab(conn, SLAB_PUBKEY);
  const h = parseHeader(buf);
  const c = parseConfig(buf);
  const e = parseEngine(buf);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB_PUBKEY);

  console.log("\n=== Bounty 3 mainnet market state ===");
  console.log(`  programId:          ${PROGRAM_ID.toBase58()}`);
  console.log(`  slab:               ${SLAB_PUBKEY.toBase58()}`);
  console.log(`  vault PDA:          ${vaultPda.toBase58()}`);
  console.log(`  oracle:             ${PYTH_SOL_USD.toBase58()}`);
  console.log(`  admin:              ${h.admin.toBase58()} (NOT YET BURNED)`);
  console.log(`  insurance auth:     ${h.insuranceAuthority.toBase58()} (NOT YET BURNED)`);
  console.log(`  insurance op:       ${h.insuranceOperator.toBase58()} (NOT YET BURNED)`);
  console.log(`  inverted:           ${c.invert ? "yes" : "no"}`);
  console.log(`  tvl_cap_mult:       ${c.tvlInsuranceCapMult}`);
  console.log(`  perm_resolve:       ${c.permissionlessResolveStaleSlots} slots (~${(Number(c.permissionlessResolveStaleSlots) * 0.4 / 3600).toFixed(2)}h)`);
  console.log(`  force_close:        ${c.forceCloseDelaySlots} slots (~${(Number(c.forceCloseDelaySlots) * 0.4 / 3600).toFixed(2)}h)`);
  console.log(`  maint fee/slot:     ${c.maintenanceFeePerSlot}`);
  console.log(`  new_account_fee:    ${c.newAccountFee} (~${(Number(c.newAccountFee) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log(`  insurance balance:  ${e.insuranceFund.balance} (= ${(Number(e.insuranceFund.balance) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log(`  vault:              ${e.vault} (= ${(Number(e.vault) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log(`  market_mode:        ${e.marketMode === 0 ? "Live" : "Resolved"}`);

  // Manifest
  const out = {
    network: "mainnet",
    bountyVersion: "bounty_sol_20x_max",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    slab: SLAB_PUBKEY.toBase58(),
    slabSize: SLAB_LEN,
    mint: NATIVE_MINT.toBase58(),
    collateral: "wSOL (9 decimals, unit_scale=0)",
    vaultPda: vaultPda.toBase58(),
    oracle: PYTH_SOL_USD.toBase58(),
    oracleType: "pyth_pull",
    feedId: PYTH_SOL_USD_FEED_ID,
    inverted: true,
    insuranceFundLamports: e.insuranceFund.balance.toString(),
    insuranceFundSol: Number(e.insuranceFund.balance) / LAMPORTS_PER_SOL,
    tvlInsuranceCapMult: c.tvlInsuranceCapMult,
    matcher: "(none — third parties provision their own)",
    admin: h.admin.toBase58(),
    insuranceAuthority: h.insuranceAuthority.toBase58(),
    insuranceOperator: h.insuranceOperator.toBase58(),
    hyperpAuthority: c.hyperpAuthority.equals(PublicKey.default)
      ? "🔥 BURNED (auto for non-Hyperp)"
      : c.hyperpAuthority.toBase58(),
    riskParams: {
      maintenance_margin_bps: 500,
      initial_margin_bps: 500,
      trading_fee_bps: 1,
      liquidation_fee_bps: 5,
      max_price_move_bps_per_slot: 49,
      h_min: 0,
      h_max: 86400,
      min_nonzero_mm_req: 500,
      min_nonzero_im_req: 600,
      min_liquidation_abs: 0,
      liquidation_fee_cap: 50_000_000_000,
    },
    permissionlessResolveStaleSlots: c.permissionlessResolveStaleSlots.toString(),
    forceCloseDelaySlots: c.forceCloseDelaySlots.toString(),
    autoShutdown: "48h oracle stale → ResolvePermissionless; 48h post-resolve → ForceCloseResolved",
    nextSteps: [
      "1. Install cron tick: scripts/mainnet-bounty3-cron-install.ts",
      "2. Verify ≥3 ticks land via crontab (~3 min wait)",
      "3. Burn authorities: scripts/burn-mainnet-bounty3-authorities.ts",
      "4. Burn upgrade authority via solana program set-upgrade-authority --new-upgrade-authority null",
    ],
  };
  fs.writeFileSync("mainnet-bounty3-market.json", JSON.stringify(out, null, 2));
  console.log("\nWrote mainnet-bounty3-market.json");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
