/**
 * Devnet end-to-end (via the CLI) of the permissionless-market lifecycle that
 * tests/v16_wrapper.rs:2555 proves at the unit level:
 *   1. admin market with a permissionless market-init fee
 *   2. ATTACKER (non-admin) permissionlessly activates asset 1, paying the fee
 *   3. two portfolios open opposing positions on asset 1, then abandon them
 *   4. admin SHUTDOWN asset 1 (starts the force_close_delay timer)
 *   5. pre-timeout ForceCloseAbandonedAsset is rejected
 *   6. post-timeout ForceCloseAbandonedAsset (permissionless cranker) closes them
 *   7. admin RETIRE asset 1
 *   8. attacker re-activates index 1 -> fresh market_id (slot reused)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encConfigureHyperpMark,
  encConfigurePermissionlessResolve, encUpdateMarketInitFeePolicy,
  encTradeNoCpi, encUpdateAssetLifecycle, encForceCloseAbandonedAsset,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN, MARKET_GROUP_OFF, MG,
  ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN, AS,
} from "../src/v16/index.js";

const PROGRAM_ID = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const attacker = Keypair.generate();
const withCu = (u: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units: u }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
const vaultAuthOf = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], PROGRAM_ID)[0];
const send = (tx: Transaction, s: Keypair[]) => sendAndConfirmTransaction(conn, tx, s, { commitment: "confirmed" });
async function attempt(label: string, ixs: TransactionInstruction[], signers: Keypair[], skipPre = false) {
  try { const sig = await send(new Transaction().add(...withCu(700_000), ...ixs), signers); console.log(`  ${label}: OK`); return true; }
  catch (e: any) { const code = (e.logs || []).join(" ").match(/custom program error: (0x[0-9a-f]+)/)?.[1] || (e.message || "").split("\n")[0].slice(0, 60); console.log(`  ${label}: REJECTED (${code})`); if (/WithdrawInsuranceDomain/.test(label) && e.logs) console.log(e.logs.filter((l:string)=>/Program log|exceeded|access|stack|Error|failed/i.test(l)).slice(-6).map((l:string)=>"      "+l).join("\n")); return false; }
}
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
async function asset1(market: PublicKey) {
  const b = Buffer.from((await conn.getAccountInfo(market, "confirmed"))!.data);
  const eng = MARKET_GROUP_OFF + MG.asset_slots + 1 * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
  return { marketId: b.readBigUInt64LE(eng + AS.market_id), lifecycle: b.readUInt8(eng + AS.lifecycle), oiLong: u128(b, eng + AS.oi_eff_long_q), oiShort: u128(b, eng + AS.oi_eff_short_q) };
}

async function main() {
  console.log("admin:", admin.publicKey.toBase58(), "attacker:", attacker.publicKey.toBase58());
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: attacker.publicKey, lamports: 200_000_000 })), [admin]);
  const market = Keypair.generate(), longP = Keypair.generate(), shortP = Keypair.generate();
  const vaultAuth = vaultAuthOf(market.publicKey);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const attackerAta = getAssociatedTokenAddressSync(NATIVE_MINT, attacker.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const FEE = 1_000_000n;        // 0.001 SOL permissionless market-init fee
  const FCD = 12n;               // force_close_delay slots (~5s)
  const SIZE = 2_000_000n;       // 2 * POS_SCALE
  const PRICE = 1_000_000n;

  await send(new Transaction().add(...withCu(60_000))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey, lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: longP.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: shortP.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
    [admin, market, longP, shortP]);
  // InitMarket with ONLY asset 0 (max_portfolio_assets=1) so the attacker appends asset 1
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: NATIVE_MINT, isSigner: false, isWritable: false }], data: encInitMarket({ maxPortfolioAssets: 1, hMin: 0n, hMax: 6_480_000n, initialPrice: PRICE, minNonzeroMmReq: 500n, minNonzeroImReq: 600n, maintenanceMarginBps: 500n, initialMarginBps: 500n, maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n, liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n, minLiquidationAbs: 0n, maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n, maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n, maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n, maxBankruptCloseLifetimeSlots: 10_000_000n, publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 0n }) })), [admin]);
  let slot = BigInt(await conn.getSlot("confirmed"));
  await send(new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot, initialMarkE6: PRICE, markEwmaHalflifeSlots: 300n, markMinFee: 500n }) })), [admin]);
  await send(new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigurePermissionlessResolve({ staleSlots: 100n, forceCloseDelaySlots: FCD }) })), [admin]);
  await send(new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encUpdateMarketInitFeePolicy(FEE) })), [admin]);
  console.log("admin market created (asset 0 only), init-fee + force_close_delay set");

  // vault ATA + admin/attacker wSOL
  await send(new Transaction().add(...withCu(50_000)).add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT)).add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT)).add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 1_000_000_000 })).add({ keys: [{ pubkey: adminAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }), [admin]);
  await send(new Transaction().add(...withCu(50_000)).add(createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerAta, attacker.publicKey, NATIVE_MINT)).add(SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: attackerAta, lamports: 50_000_000 })).add({ keys: [{ pubkey: attackerAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }), [attacker]);

  // 2. ATTACKER permissionlessly activates asset 1 (pays FEE)
  slot = BigInt(await conn.getSlot("confirmed"));
  const auths = { insuranceAuthority: admin.publicKey, insuranceOperator: admin.publicKey, backingBucketAuthority: admin.publicKey, oracleAuthority: admin.publicKey };
  const okCreate = await attempt("ATTACKER permissionless-activate asset 1 (pays fee)", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: attacker.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: attackerAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encUpdateAssetLifecycle({ action: 0, assetIndex: 1, nowSlot: slot, initialPrice: PRICE, ...auths }) })], [attacker]);
  if (!okCreate) throw new Error("permissionless activate failed");
  const a1 = await asset1(market.publicKey);
  const oldMarketId = a1.marketId;
  console.log(`  asset 1 active: lifecycle=${a1.lifecycle} market_id=${oldMarketId}`);

  // 3. open opposing positions on asset 1, then abandon
  for (const p of [longP, shortP]) {
    await send(new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }], data: encInitPortfolio() })), [admin]);
    await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encDeposit(300_000_000n) })), [admin]);
  }
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: longP.publicKey, isSigner: false, isWritable: true }, { pubkey: shortP.publicKey, isSigner: false, isWritable: true }], data: encTradeNoCpi({ assetIndex: 1, sizeQ: SIZE, execPrice: PRICE, feeBps: 0n }) })), [admin]);
  let s = await asset1(market.publicKey);
  console.log(`  positions opened: asset1 oiLong=${s.oiLong} oiShort=${s.oiShort} (then abandoned)`);

  // 4. admin SHUTDOWN asset 1
  slot = BigInt(await conn.getSlot("confirmed"));
  const okShutdown = await attempt("admin SHUTDOWN asset 1 (start timer)", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encUpdateAssetLifecycle({ action: 3, assetIndex: 1, nowSlot: slot, initialPrice: 0n, ...auths }) })], [admin]);
  console.log(`  asset 1 lifecycle now=${(await asset1(market.publicKey)).lifecycle} (5=Recovery)`);

  // 5. pre-timeout ForceClose rejects
  slot = BigInt(await conn.getSlot("confirmed"));
  const fcKeys = [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: longP.publicKey, isSigner: false, isWritable: true }, { pubkey: shortP.publicKey, isSigner: false, isWritable: true }];
  console.log("PRE-TIMEOUT ForceCloseAbandonedAsset (expect REJECT):");
  await attempt("  ForceCloseAbandonedAsset asset1 (too early)", [new TransactionInstruction({ programId: PROGRAM_ID, keys: fcKeys, data: encForceCloseAbandonedAsset({ assetIndex: 1, nowSlot: slot, closeQ: SIZE }) })], [admin]);

  console.log("\nwaiting force_close_delay (~6s)…");
  await new Promise(r => setTimeout(r, 7000));

  // 6. post-timeout ForceClose (permissionless cranker = admin, owners NOT signing)
  slot = BigInt(await conn.getSlot("confirmed"));
  console.log("POST-TIMEOUT ForceCloseAbandonedAsset (cranker closes abandoned positions):");
  const okForce = await attempt("  ForceCloseAbandonedAsset asset1", [new TransactionInstruction({ programId: PROGRAM_ID, keys: fcKeys, data: encForceCloseAbandonedAsset({ assetIndex: 1, nowSlot: slot, closeQ: SIZE }) })], [admin]);
  s = await asset1(market.publicKey);
  console.log(`  after force-close: asset1 oiLong=${s.oiLong} oiShort=${s.oiShort}`);

  // diagnose: asset-1 domain budgets (domains 2,3) + locks before retire
  {
    const b = Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data);
    const eng1 = MARKET_GROUP_OFF + MG.asset_slots + 1 * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
    const dl = u128(b, eng1 + 499 + 0) - u128(b, eng1 + 499 + 32);
    const ds = u128(b, eng1 + 499 + 16) - u128(b, eng1 + 499 + 48);
    console.log(`  [pre-retire] asset1 domain2 rem=${dl} domain3 rem=${ds} mode=${b.readUInt8(MARKET_GROUP_OFF+MG.mode)} lossStale=${b.readUInt8(MARKET_GROUP_OFF+MG.loss_stale_active)}`);
    // drain non-zero asset-1 domains (admin can after shutdown)
    for (const [domain, rem] of [[2, dl], [3, ds]] as const) {
      if (rem > 0n) await attempt(`  WithdrawInsuranceDomain(${domain}, ${rem})`, [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: (await import("../src/v16/index.js")).encWithdrawInsuranceDomain({ domain, amount: rem }) })], [admin]);
    }
  }

  // 7. admin RETIRE asset 1
  slot = BigInt(await conn.getSlot("confirmed"));
  const okRetire = await attempt("admin RETIRE asset 1", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encUpdateAssetLifecycle({ action: 2, assetIndex: 1, nowSlot: slot, initialPrice: 0n, ...auths }) })], [admin]);
  console.log(`  asset 1 lifecycle now=${(await asset1(market.publicKey)).lifecycle} (4=Retired)`);

  // 8. attacker reuses index 1
  slot = BigInt(await conn.getSlot("confirmed"));
  const okReuse = await attempt("ATTACKER re-activate index 1 (reuse, pays fee)", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: attacker.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: attackerAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encUpdateAssetLifecycle({ action: 0, assetIndex: 1, nowSlot: slot, initialPrice: 250_000n, ...auths }) })], [attacker]);
  const a1b = await asset1(market.publicKey);
  console.log(`  reused asset 1: lifecycle=${a1b.lifecycle} market_id=${a1b.marketId} (old was ${oldMarketId})`);

  console.log("\n=== LIFECYCLE RESULT ===");
  console.log(`permissionless create: ${okCreate?"OK":"FAIL"} | shutdown timer: ${okShutdown?"OK":"FAIL"} | force-close: ${okForce?"OK":"FAIL"} (oi now ${s.oiLong}/${s.oiShort}) | retire: ${okRetire?"OK":"FAIL"} | reuse: ${okReuse?"OK":"FAIL"} (market_id ${oldMarketId}->${a1b.marketId})`);
  const pass = okCreate && okShutdown && okForce && s.oiLong===0n && s.oiShort===0n && okRetire && okReuse && a1b.marketId > oldMarketId;
  console.log(pass ? "✅ FULL LIFECYCLE CONFIRMED ON DEVNET VIA CLI" : "❌ lifecycle incomplete — see steps above");
}
main().catch(e => { console.error("FATAL:", e.message || e); if (e.logs) console.error(e.logs.slice(-8).join("\n")); process.exit(1); });
