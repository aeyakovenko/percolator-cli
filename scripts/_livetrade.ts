/** Live mainnet catch-up + TradeNoCpi smoke for m0 (SOL/USD) and m2 (BTC).
 * Per market: (1) ConfigureHybridOracle re-anchor echoing the EXACT live config
 * (resets slot_last=now + mark to fresh oracle), (2) VERIFY config unchanged
 * (abort if any field drifts), (3) bilateral TradeNoCpi open + close at the fresh
 * mark. Then withdraw + close the two test portfolios. DRY=1 previews + re-anchors
 * only (no trade). MKT=m0|m2|both. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as fs from "fs";
import { encConfigureHybridOracle, encInitPortfolio, encDeposit, encWithdraw, encTradeNoCpi, encPermissionlessCrank, encClosePortfolio, PORTFOLIO_ACCOUNT_LEN } from "../src/v16/index.js";
import { parseMarketGroup, parseWrapperConfig, parseAssetOracleProfile } from "../src/v16/parsers.js";
import { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN } from "../src/v16/constants.js";

const HOME = process.env.HOME!;
const DRY = process.env.DRY === "1";
const WHICH = (process.env.MKT ?? "both").toLowerCase();
const RPC = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const PROGRAM_ID = new PublicKey(M.programId), MARKET = new PublicKey(M.market);
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));
const ZERO = "00".repeat(32);
const DEF = { maxStalenessSecs: 600n, hybridSoftStaleSlots: 1800n, markEwmaHalflifeSlots: 300n, markMinFee: 500n, unitScale: 0, confFilterBps: 200, invert: 1 };
const MKTS: any = {
  m0: { idx: 0, legCount: 1, flags: 0, feeds: [M.markets[0].legFeedIds[0], ZERO, ZERO], accts: M.markets[0].oracleAccounts.map((a: string) => new PublicKey(a)) },
  m2: { idx: 2, legCount: 2, flags: 1, feeds: [M.markets[2].legFeedIds[0], M.markets[2].legFeedIds[1], ZERO], accts: M.markets[2].oracleAccounts.map((a: string) => new PublicKey(a)) },
};
const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROGRAM_ID)[0];
const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
const cu = (u = 500_000) => [ComputeBudgetProgram.setComputeUnitLimit({ units: u }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
const send = (ixs: TransactionInstruction[], signers: Keypair[] = [admin]) => sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ...ixs), signers, { commitment: "confirmed", skipPreflight: true });
const code = (e: any) => { const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + (e?.message ?? ""); const h = s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? s.match(/"Custom":\s*(\d+)/)?.[1]; return h ?? s.slice(0, 80); };

async function cfgOf(idx: number) {
  const buf = Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data);
  const g: any = parseMarketGroup(buf);
  const asset = g.assets.find((a: any) => a.index === idx);
  let o: any;
  if (idx === 0) o = parseWrapperConfig(buf); else o = parseAssetOracleProfile(buf, MARKET_GROUP_OFF + MG.asset_slots + idx * ASSET_SLOT_LEN, idx);
  return { legCount: Number(o.oracleLegCount), flags: Number(o.oracleLegFlags), invert: Number(o.invert), confFilter: Number(o.confFilterBps), maxStale: Number(o.maxStalenessSecs), softStale: Number(o.hybridSoftStaleSlots), slotLast: BigInt(asset.slotLast ?? 0n), effPx: BigInt(asset.effectivePrice ?? 0n) };
}
const sameCfg = (a: any, b: any) => a.legCount === b.legCount && a.flags === b.flags && a.invert === b.invert && a.confFilter === b.confFilter && a.maxStale === b.maxStale && a.softStale === b.softStale;

async function reanchor(m: any) {
  const before = await cfgOf(m.idx);
  const slot = BigInt(await conn.getSlot("confirmed"));
  console.log(`  m${m.idx} before: legCount=${before.legCount} flags=${before.flags} confFilter=${before.confFilter} slot_last=${before.slotLast} (lag ${slot - before.slotLast}) effPx=${before.effPx}`);
  // PRE-SEND GUARD: only submit if the on-chain config already equals the params we'll
  // send → the re-anchor is provably idempotent (resets slot_last only, never changes config).
  const intended = { legCount: m.legCount, flags: m.flags, invert: DEF.invert, confFilter: DEF.confFilterBps, maxStale: Number(DEF.maxStalenessSecs), softStale: Number(DEF.hybridSoftStaleSlots) };
  if (!sameCfg(before, intended)) throw new Error(`m${m.idx} on-chain cfg != intended params (${JSON.stringify(before)} vs ${JSON.stringify(intended)}) — REFUSING to send (would change live oracle)`);
  const mkIx = (s: bigint) => new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true },
    ...m.accts.map((a: PublicKey) => ({ pubkey: a, isSigner: false, isWritable: false }))],
    data: encConfigureHybridOracle({ assetIndex: m.idx, nowSlot: s, nowUnixTs: BigInt(Math.floor(Date.now() / 1000)), oracleLegCount: m.legCount, oracleLegFlags: m.flags, maxStalenessSecs: DEF.maxStalenessSecs, hybridSoftStaleSlots: DEF.hybridSoftStaleSlots, markEwmaHalflifeSlots: DEF.markEwmaHalflifeSlots, markMinFee: DEF.markMinFee, invert: DEF.invert, unitScale: DEF.unitScale, confFilterBps: DEF.confFilterBps, oracleLegFeeds: m.feeds }) });
  // preflight + retry (transient 2-leg oracle-freshness can reject) + assert slot_last actually reset
  let after: any; let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    const s = BigInt(await conn.getSlot("confirmed"));
    try { await sendAndConfirmTransaction(conn, new Transaction().add(...cu(), mkIx(s)), [admin], { commitment: "confirmed", skipPreflight: false }); } catch (e: any) { console.log(`    m${m.idx} re-anchor attempt ${attempt}: ${code(e)} — retry`); await new Promise(r => setTimeout(r, 1500)); continue; }
    after = await cfgOf(m.idx);
    ok = (BigInt(await conn.getSlot("confirmed")) - after.slotLast) < 100n;
    if (!ok) { console.log(`    m${m.idx} re-anchor landed but slot_last not reset (lag ${BigInt(await conn.getSlot("confirmed")) - after.slotLast}) — retry`); await new Promise(r => setTimeout(r, 1500)); }
  }
  if (!ok) throw new Error(`m${m.idx} re-anchor failed to reset slot_last after retries`);
  console.log(`  m${m.idx} after:  slot_last=${after.slotLast} (lag ${BigInt(await conn.getSlot("confirmed")) - after.slotLast}) effPx=${after.effPx}  cfg-unchanged=${sameCfg(before, after) ? "✅" : "🚨 CHANGED"}`);
  if (!sameCfg(before, after)) throw new Error(`m${m.idx} oracle CONFIG DRIFTED — aborting before any trade`);
  return after.effPx;
}

(async () => {
  console.log(`=== live catch-up + trade on ${MARKET.toBase58()} (MKT=${WHICH} DRY=${DRY}) ===`);
  console.log(`admin ${admin.publicKey.toBase58()} balance ${(await conn.getBalance(admin.publicKey) / 1e9).toFixed(4)} SOL`);
  const targets = WHICH === "both" ? [MKTS.m0, MKTS.m2] : [MKTS[WHICH]];

  console.log("\n[1] re-anchor (ConfigureHybridOracle, echo exact config + verify unchanged)");
  const marks: Record<number, bigint> = {};
  for (const m of targets) marks[m.idx] = await reanchor(m);
  if (DRY) { console.log("\nDRY: re-anchor done, skipping portfolios/trades."); return; }

  console.log("\n[2] fund 2 test portfolios (A, B)");
  const A = Keypair.generate(), B = Keypair.generate();
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  await send([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 400_000_000 }),
    { keys: [{ pubkey: adminAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }]);
  await send([SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: A.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: B.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })], [admin, A, B]);
  for (const p of [A, B]) await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }], data: encInitPortfolio() })]);
  const dep = (p: PublicKey, amt: bigint) => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encDeposit(amt) })]);
  await dep(A.publicKey, 150_000_000n); await dep(B.publicKey, 150_000_000n);
  console.log("  funded A + B with 0.15 SOL each");

  const crank = async (idx: number, accts: PublicKey[]) => { const s = BigInt(await conn.getSlot("confirmed")); return send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: A.publicKey, isSigner: false, isWritable: true }, ...accts.map(a => ({ pubkey: a, isSigner: false, isWritable: false }))], data: encPermissionlessCrank({ action: 0, assetIndex: idx, nowSlot: s, fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })]).catch(() => {}); };
  const tradeKeys = [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: A.publicKey, isSigner: false, isWritable: true }, { pubkey: B.publicKey, isSigner: false, isWritable: true }];
  const SIZE = 20_000_000n;

  for (const m of targets) {
    console.log(`\n[3] TradeNoCpi open+close on m${m.idx} @ mark ${marks[m.idx]}`);
    await crank(m.idx, m.accts);
    try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: tradeKeys, data: encTradeNoCpi({ assetIndex: m.idx, sizeQ: SIZE, execPrice: marks[m.idx], feeBps: 1n }) })]); console.log(`  ✅ OPEN m${m.idx} A long / B short ${Number(SIZE)/1e6}`); }
    catch (e: any) { console.log(`  ❌ OPEN m${m.idx}: ${code(e)}`); continue; }
    await crank(m.idx, m.accts);
    try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: tradeKeys, data: encTradeNoCpi({ assetIndex: m.idx, sizeQ: -SIZE, execPrice: marks[m.idx], feeBps: 1n }) })]); console.log(`  ✅ CLOSE m${m.idx}`); }
    catch (e: any) { console.log(`  ❌ CLOSE m${m.idx}: ${code(e)}`); }
  }

  console.log("\n[4] teardown: catch-up crank, withdraw, close portfolios");
  for (const m of targets) { await crank(m.idx, m.accts); await crank(m.idx, m.accts); }
  for (const [n, p] of [["A", A], ["B", B]] as const) {
    const buf = Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data); // refresh
    const pinfo = await conn.getAccountInfo(p.publicKey, "confirmed");
    const { parsePortfolio } = await import("../src/v16/parsers.js");
    const pp: any = pinfo ? parsePortfolio(Buffer.from(pinfo.data)) : null;
    const capN = pp ? BigInt(pp.capital) : 0n;
    if (capN > 0n) { try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encWithdraw(capN) })]); console.log(`  withdraw ${n}: ${Number(capN)/1e9} SOL`); } catch (e: any) { console.log(`  withdraw ${n}: ${code(e)}`); } }
    try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }], data: encClosePortfolio() })]); console.log(`  ✅ ClosePortfolio ${n}`); } catch (e: any) { console.log(`  ClosePortfolio ${n}: ${code(e)} (rent stays until closeable)`); }
  }
  console.log(`\n✅ done. admin balance ${(await conn.getBalance(admin.publicKey) / 1e9).toFixed(4)} SOL`);
})().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
