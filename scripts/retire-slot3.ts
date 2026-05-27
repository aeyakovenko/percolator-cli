/** One-shot STEP B: RETIRE the shut-down slot-3 asset on mainnet BhkMic5g once the
 * force-close maturity elapses. Idempotent + safe to run repeatedly (e.g. from cron):
 *   - already RETIRED (lc=4)        → prints RETIRE_DONE, exit 0
 *   - not in RECOVERY (lc!=5)       → prints abort, exit 0 (no-op)
 *   - not matured yet               → prints slots-left, exit 0 (cron retries)
 *   - matured                       → sends admin RETIRE; on success prints RETIRE_DONE
 * The wrapper cron removes itself when it sees RETIRE_DONE. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import { encUpdateAssetLifecycle } from "../src/v16/index.js";
import { parseMarketGroup, parseAssetOracleProfile } from "../src/v16/parsers.js";
import { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN } from "../src/v16/constants.js";

const HOME = process.env.HOME!;
const ASSET = 3;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const conn = new Connection(RPC, "confirmed");
const PROGRAM_ID = new PublicKey(M.programId), MARKET = new PublicKey(M.market);
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));
const ZERO = PublicKey.default;
const FORCE_CLOSE_DELAY = BigInt(M.forceCloseDelaySlots ?? 216000);
const cu = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 60_000 })];
const code = (e: any) => { const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + String(e?.message ?? ""); const h = s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]; if (h) return h; const d = s.match(/"Custom":\s*(\d+)/)?.[1]; return d ? "0x" + Number(d).toString(16) : s.slice(0, 100); };
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function state() {
  const b = Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data);
  const mg: any = parseMarketGroup(b);
  const lifecycle = (mg.assets ?? []).find((a: any) => a.index === ASSET)?.lifecycle;
  const slotOff = MARKET_GROUP_OFF + MG.asset_slots + ASSET * ASSET_SLOT_LEN;
  const prof: any = parseAssetOracleProfile(b, slotOff, ASSET);
  return { lifecycle, shutdownSlot: BigInt(prof.lastGoodOracleSlot) };
}

(async () => {
  const { lifecycle, shutdownSlot } = await state();
  if (lifecycle === 4) { console.log(`${ts()} slot ${ASSET} already RETIRED. RETIRE_DONE`); return; }
  if (lifecycle !== 5) { console.log(`${ts()} slot ${ASSET} lifecycle=${lifecycle} (expected 5 Recovery) — abort, no-op.`); return; }

  const nowSlot = BigInt(await conn.getSlot("confirmed"));
  const elapsed = nowSlot - shutdownSlot;
  if (elapsed < FORCE_CLOSE_DELAY) {
    const left = FORCE_CLOSE_DELAY - elapsed;
    console.log(`${ts()} not matured: ${elapsed}/${FORCE_CLOSE_DELAY} slots (~${(Number(left) * 0.4 / 60).toFixed(1)} min left) — will retry.`);
    return;
  }

  console.log(`${ts()} matured (${elapsed} ≥ ${FORCE_CLOSE_DELAY}) — sending admin RETIRE(asset ${ASSET})…`);
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true },
  ], data: encUpdateAssetLifecycle({ action: 2 /* RETIRE */, assetIndex: ASSET, nowSlot, initialPrice: 0n, insuranceAuthority: ZERO, insuranceOperator: ZERO, backingBucketAuthority: ZERO, oracleAuthority: ZERO }) });
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ix), [admin], { commitment: "confirmed", skipPreflight: true });
    const after = await state();
    if (after.lifecycle === 4) console.log(`${ts()} ✅ RETIRE confirmed ${sig} — slot ${ASSET} now RETIRED. RETIRE_DONE`);
    else console.log(`${ts()} ⚠️ tx ${sig} sent but lifecycle=${after.lifecycle} — will retry.`);
  } catch (e: any) { console.log(`${ts()} RETIRE failed: ${code(e)} — will retry next tick.`); }
})().catch((e) => { console.log(`${ts()} FATAL: ${e.message || e} — will retry.`); });
