/**
 * Un-freeze the live mainnet bounty-5 market (8oYjDr2): the deploy set
 * permissionless_resolve_stale_slots=100 (~40s) which hard-freezes the market
 * (0x1b OracleStale) after ~40s un-cranked. Raise it to the ~30-day MAX and
 * re-freshen the 3 oracles (jump-resets last_good_oracle_slot to now). Admin-only;
 * works while the market is Live with no positions. Run BEFORE starting the keeper.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import {
  encConfigurePermissionlessResolve, encConfigureHybridOracle,
  ORACLE_LEG_FLAG_DIVIDE_LEG2, ORACLE_LEG_FLAG_DIVIDE_LEG3,
} from "../src/v16/index.js";

const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const PROGRAM_ID = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim()}`, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const cu = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 })];
const send = (ixs: TransactionInstruction[]) => sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ...ixs), [admin], { commitment: "confirmed", skipPreflight: true });

const FEED_SOL = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const FEED_STOXX = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
const FEED_EUR = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
const FEED_BTC = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const Z = "0".repeat(64);
const SOL = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const EUR = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const BTC = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
const OD = { maxStalenessSecs: 600n, hybridSoftStaleSlots: 1800n, markEwmaHalflifeSlots: 300n, markMinFee: 500n, unitScale: 0, confFilterBps: 200 };
const ASSETS = [
  { assetIndex: 0, oracleLegCount: 1, oracleLegFlags: 0, invert: 1, oracleLegFeeds: [FEED_SOL, Z, Z] as [string, string, string], accts: [SOL] },
  { assetIndex: 1, oracleLegCount: 3, oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3, invert: 1, oracleLegFeeds: [FEED_STOXX, FEED_EUR, FEED_SOL] as [string, string, string], accts: [STOXX, EUR, SOL] },
  { assetIndex: 2, oracleLegCount: 2, oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG2, invert: 1, oracleLegFeeds: [FEED_BTC, FEED_SOL, Z] as [string, string, string], accts: [BTC, SOL] },
];

async function main() {
  console.log(`unfreeze market ${MARKET.toBase58()} prog ${PROGRAM_ID.toBase58()}`);
  const fcd = BigInt(M.forceCloseDelaySlots ?? 216000);
  await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true },
  ], data: encConfigurePermissionlessResolve({ staleSlots: 6_480_000n, forceCloseDelaySlots: fcd }) })]);
  console.log(`  ✅  ConfigurePermissionlessResolve(stale=6_480_000, delay=${fcd})`);
  for (const a of ASSETS) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    try {
      await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true },
        ...a.accts.map((p) => ({ pubkey: p, isSigner: false, isWritable: false })),
      ], data: encConfigureHybridOracle({ assetIndex: a.assetIndex, nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now() / 1000)), oracleLegCount: a.oracleLegCount, oracleLegFlags: a.oracleLegFlags, maxStalenessSecs: OD.maxStalenessSecs, hybridSoftStaleSlots: OD.hybridSoftStaleSlots, markEwmaHalflifeSlots: OD.markEwmaHalflifeSlots, markMinFee: OD.markMinFee, invert: a.invert, unitScale: OD.unitScale, confFilterBps: OD.confFilterBps, oracleLegFeeds: a.oracleLegFeeds }) })]);
      console.log(`  ✅  re-freshen m${a.assetIndex}`);
    } catch (e: any) {
      console.log(`  ❌  re-freshen m${a.assetIndex}: ${(e.transactionLogs ?? e.logs ?? []).join(" ").match(/custom program error: (0x[0-9a-f]+)/)?.[1] ?? (e.message || "").slice(0, 60)}`);
    }
  }
  console.log("done — market un-frozen (perm_resolve=30d). Start the keeper to keep it fresh.");
}
main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
