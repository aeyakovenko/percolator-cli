/**
 * Devnet: can the admin start a shutdown timer AND force-close a FOREIGN
 * account's abandoned open position in the shut-down asset?
 *   1. asset 1 hyperp, force_close_delay short
 *   2. foreign key F deposits + opens a long in asset 1 (admin is short counterparty)
 *   3. admin SHUTDOWN asset 1 (starts timer; asset -> RECOVERY)        [expect OK]
 *   4. wait the delay
 *   5. admin tries to force-close F's leg WITHOUT F signing:
 *        - ForfeitRecoveryLeg(F, asset1) owner=F not signing            [expect REJECT]
 *      and F can self-forfeit (owner signs)                            [expect OK]
 * Conclusion: if (5a) rejects, admin can't force-close abandoned positions.
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
  encConfigurePermissionlessResolve, encTradeNoCpi, encForfeitRecoveryLeg,
  encPushHyperpMark, encUpdateAssetLifecycle, encPermissionlessCrank,
  encUpdateLiquidationFeePolicy,
  parsePortfolio,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
} from "../src/v16/index.js";

const PROGRAM_ID = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const F = Keypair.generate();  // foreign participant
const withCu = (u: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units: u }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
const vaultAuthOf = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], PROGRAM_ID)[0];
const send = (tx: Transaction, s: Keypair[]) => sendAndConfirmTransaction(conn, tx, s, { commitment: "confirmed" });
async function attempt(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  try { const sig = await send(new Transaction().add(...withCu(600_000), ...ixs), signers); console.log(`  ${label}: OK (${sig.slice(0,8)}…)`); return true; }
  catch (e: any) { const code = (e.logs||[]).join(" ").match(/custom program error: (0x[0-9a-f]+)/)?.[1] || (e.message||"").split("\n")[0]; console.log(`  ${label}: REJECTED (${code})`); return false; }
}

async function main() {
  console.log("admin:", admin.publicKey.toBase58(), "foreign F:", F.publicKey.toBase58());
  // fund foreign
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: F.publicKey, lamports: 600_000_000 })), [admin]);
  const market = Keypair.generate(), portA = Keypair.generate(), portF = Keypair.generate();
  const vaultAuth = vaultAuthOf(market.publicKey);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const fAta = getAssociatedTokenAddressSync(NATIVE_MINT, F.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  // admin creates market + portA (admin) ; F creates portF (signs to own it)
  await send(new Transaction().add(...withCu(60_000))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey, lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portF.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
    [admin, market, portA, portF]);
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: NATIVE_MINT, isSigner: false, isWritable: false }], data: encInitMarket({ maxPortfolioAssets: 4, hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n, minNonzeroMmReq: 500n, minNonzeroImReq: 600n, maintenanceMarginBps: 500n, initialMarginBps: 500n, maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n, liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n, minLiquidationAbs: 0n, maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n, maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n, maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n, maxBankruptCloseLifetimeSlots: 10_000_000n, publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 58n }) })), [admin]);
  const slot0 = BigInt(await conn.getSlot("confirmed"));
  await send(new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigureHyperpMark({ assetIndex: 1, nowSlot: slot0, initialMarkE6: 1_000_000n, markEwmaHalflifeSlots: 300n, markMinFee: 500n }) })), [admin]);
  await send(new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigurePermissionlessResolve({ staleSlots: 100n, forceCloseDelaySlots: 5n }) })), [admin]);
  // wrap admin + F
  await send(new Transaction().add(...withCu(50_000)).add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT)).add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT)).add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 800_000_000 })).add({ keys: [{ pubkey: adminAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }), [admin]);
  await send(new Transaction().add(...withCu(50_000)).add(createAssociatedTokenAccountIdempotentInstruction(F.publicKey, fAta, F.publicKey, NATIVE_MINT)).add(SystemProgram.transfer({ fromPubkey: F.publicKey, toPubkey: fAta, lamports: 400_000_000 })).add({ keys: [{ pubkey: fAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }), [F]);
  // init + deposit: portA by admin, portF by F
  await send(new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portA.publicKey, isSigner: false, isWritable: true }], data: encInitPortfolio() })), [admin]);
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portA.publicKey, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encDeposit(300_000_000n) })), [admin]);
  await send(new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: F.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portF.publicKey, isSigner: false, isWritable: true }], data: encInitPortfolio() })), [F]);
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: F.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portF.publicKey, isSigner: false, isWritable: true }, { pubkey: fAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encDeposit(300_000_000n) })), [F]);
  console.log("setup done: portA(admin) + portF(foreign) funded; asset 1 hyperp");

  // open: portF long asset1, portA short — taker=F, maker=admin (both sign)
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: F.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portF.publicKey, isSigner: false, isWritable: true }, { pubkey: portA.publicKey, isSigner: false, isWritable: true }], data: encTradeNoCpi({ assetIndex: 1, sizeQ: 10_000_000n, execPrice: 1_000_000n, feeBps: 1n }) })), [F, admin]);
  console.log("opened: portF long 10M asset 1 (admin short). F now has an open position.\n");

  // 3. admin SHUTDOWN asset 1 (start timer)
  const sslot = BigInt(await conn.getSlot("confirmed"));
  const okShutdown = await attempt("admin SHUTDOWN asset 1 (start timer)", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encUpdateAssetLifecycle({ action: 3 /*SHUTDOWN*/, assetIndex: 1, nowSlot: sslot, initialPrice: 0n, insuranceAuthority: admin.publicKey, insuranceOperator: admin.publicKey, backingBucketAuthority: admin.publicKey, oracleAuthority: admin.publicKey }) })], [admin]);

  console.log("\nwaiting force_close_delay (~7 slots)…");
  await new Promise(r => setTimeout(r, 8000));

  const posOf = async (label: string) => {
    const info = await conn.getAccountInfo(portF.publicKey, "confirmed");
    try { const pf: any = parsePortfolio(Buffer.from(info!.data)); const legs = pf.legs.filter((l: any) => l.active !== 0); console.log(`  [${label}] portF active legs=${legs.length}`); return legs.length; }
    catch (e: any) { console.log(`  [${label}] (parse skipped: ${e.message})`); return -1; }
  };
  await posOf("pre-crank");

  // PERMISSIONLESS CRANK by admin (cranker, not F): Refresh then Liquidate portF in the shut-down asset
  console.log("\nTEST — permissionless cranks by admin on F's position in the shut-down asset:");
  const nowSlot = () => conn.getSlot("confirmed").then(s => BigInt(s));
  await attempt("  Refresh crank portF asset1 [admin cranker]", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portF.publicKey, isSigner: false, isWritable: true }], data: encPermissionlessCrank({ action: 0, assetIndex: 1, nowSlot: await nowSlot(), fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })], [admin]);
  await attempt("  Liquidate crank portF asset1 closeQ=10M [admin cranker]", [new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portF.publicKey, isSigner: false, isWritable: true }], data: encPermissionlessCrank({ action: 1, assetIndex: 1, nowSlot: await nowSlot(), fundingRateE9: 0n, closeQ: 10_000_000n, feeBps: 0n, recoveryReason: 0 }) })], [admin]);
  const remaining = await posOf("post-crank");

  console.log("\n=== CONCLUSION ===");
  console.log(`admin can START shutdown timer: ${okShutdown ? "YES" : "NO"}`);
  console.log(`F's position after permissionless cranks: ${remaining === 0 ? "CLOSED ✓" : remaining < 0 ? "(parse skipped — judge by Liquidate crank result above)" : "STILL OPEN"}`);
  console.log("Liquidate crank OK => permissionless cranks CAN force-close shutdown positions.");
  console.log("Liquidate REJECTED 0x16 (NonProgress) => healthy positions need a certified deficit; cranks won't close them.");
}
main().catch(e => { console.error("FATAL:", e.message || e); if (e.logs) console.error(e.logs.slice(-8).join("\n")); process.exit(1); });
