/** Recover the empty leftover asset slot 3 on the live mainnet bounty (BhkMic5g):
 * STEP A (now): admin SHUTDOWN asset 3 (Active=2 → Recovery=5), starts the
 *   force_close_delay maturity clock.
 * STEP B (after ~force_close_delay slots): admin RETIRE asset 3 → Retired=4, frees slot.
 * This run does STEP A only and reports when STEP B becomes available.
 * DRY=1 to preview without sending. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import { encUpdateAssetLifecycle } from "../src/v16/index.js";
import { parseMarketGroup } from "../src/v16/parsers.js";
import { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN } from "../src/v16/constants.js";

const HOME = process.env.HOME!;
const DRY = process.env.DRY === "1";
const ASSET = 3;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const conn = new Connection(RPC, "confirmed");
const PROGRAM_ID = new PublicKey(M.programId), MARKET = new PublicKey(M.market);
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));
const ZERO = PublicKey.default;
const cu = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 60_000 })];
const code = (e: any) => { const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + String(e?.message ?? ""); const h = s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]; if (h) return h; const d = s.match(/"Custom":\s*(\d+)/)?.[1]; return d ? "0x" + Number(d).toString(16) : s.slice(0, 120); };
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
const eo = (a: number) => MARKET_GROUP_OFF + MG.asset_slots + a * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;

async function slotState() {
  const b = Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data);
  const mg: any = parseMarketGroup(b);
  const a = (mg.assets ?? []).find((x: any) => x.index === ASSET);
  const o = eo(ASSET);
  const budget = (u128(b, o + 499) - u128(b, o + 531)) + (u128(b, o + 515) - u128(b, o + 547));
  return { lifecycle: a?.lifecycle, effectivePrice: a?.effectivePrice, budget, forceCloseDelay: BigInt(mg.config?.forceCloseDelaySlots ?? M.forceCloseDelaySlots ?? 216000), currentSlot: BigInt(mg.currentSlot ?? 0) };
}
const LC: Record<number, string> = { 2: "ACTIVE", 3: "DRAIN_ONLY", 4: "RETIRED", 5: "RECOVERY" };

(async () => {
  console.log(`=== Recover slot ${ASSET} on mainnet ${MARKET.toBase58()} (prog ${PROGRAM_ID.toBase58()}) ===`);
  console.log(`admin ${admin.publicKey.toBase58()}  balance ${(await conn.getBalance(admin.publicKey) / 1e9).toFixed(4)} SOL`);
  const s0 = await slotState();
  console.log(`slot ${ASSET} BEFORE: lifecycle=${s0.lifecycle} (${LC[s0.lifecycle ?? -1] ?? "?"})  effective_price=${s0.effectivePrice}  budget=${(Number(s0.budget) / 1e9).toFixed(6)} SOL`);

  if (s0.lifecycle === 4) { console.log("slot already RETIRED — nothing to do."); return; }
  if (s0.budget !== 0n) { console.log(`🚨 slot has non-zero budget (${s0.budget}) — refusing to shut down; investigate first.`); process.exit(1); }
  if (!s0.effectivePrice || s0.effectivePrice === 0n) { console.log("🚨 effective_price is 0 → SHUTDOWN would revert OracleInvalid. Abort."); process.exit(1); }

  const nowSlot = BigInt(await conn.getSlot("confirmed"));
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true },
  ], data: encUpdateAssetLifecycle({ action: 3 /* SHUTDOWN */, assetIndex: ASSET, nowSlot, initialPrice: 0n, insuranceAuthority: ZERO, insuranceOperator: ZERO, backingBucketAuthority: ZERO, oracleAuthority: ZERO }) });

  if (DRY) { console.log(`\nDRY: would send SHUTDOWN(asset ${ASSET}, now_slot=${nowSlot}, initial_price=0).`); return; }
  console.log(`\nsending SHUTDOWN(asset ${ASSET}, now_slot=${nowSlot}) …`);
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ix), [admin], { commitment: "confirmed", skipPreflight: true });
    console.log(`✅ SHUTDOWN confirmed: ${sig}`);
  } catch (e: any) { console.log(`❌ SHUTDOWN failed: ${code(e)}`); process.exit(1); }

  const s1 = await slotState();
  console.log(`slot ${ASSET} AFTER:  lifecycle=${s1.lifecycle} (${LC[s1.lifecycle ?? -1] ?? "?"})`);
  if (s1.lifecycle === 5) {
    const matureAt = nowSlot + s1.forceCloseDelay;
    console.log(`\n✅ slot ${ASSET} now in RECOVERY. RETIRE becomes available after ~force_close_delay (${s1.forceCloseDelay} slots).`);
    console.log(`   maturity slot ≈ ${matureAt} (~${(Number(s1.forceCloseDelay) * 0.4 / 3600).toFixed(1)} h from now). Then run STEP B (admin RETIRE action=2).`);
  } else {
    console.log(`⚠️ unexpected lifecycle ${s1.lifecycle} after shutdown.`);
  }
})().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
