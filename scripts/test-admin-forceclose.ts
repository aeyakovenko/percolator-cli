/**
 * Devnet check: can the admin FORCE-CLOSE a resolved-market account that still
 * holds an open position? Sets up a market, opens opposing positions on two
 * admin-owned portfolios, ResolveMarket, then probes the close paths:
 *   A) CloseResolved on an account WITH an open position  (expect: gated)
 *   B) same, after force_close_delay elapses               (expect: still gated)
 *   C) RebalanceReduce (owner-signed flatten) -> CloseResolved (expect: works)
 * Conclusion printed at the end. RebalanceReduce requires the owner's signature
 * (owner_must_sign=true in the wrapper), so if (A)/(B) are gated on a flat
 * portfolio, an admin CANNOT force-close a FOREIGN account's open position.
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
  encConfigurePermissionlessResolve, encResolveMarket, encTradeNoCpi,
  encCloseResolved, encRebalanceReduce,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
} from "../src/v16/index.js";

const PROGRAM_ID = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const withCu = (u: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: u }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
];
function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}
const send = (tx: Transaction, signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
async function tryClose(label: string, ix: () => TransactionInstruction, signers: Keypair[]) {
  try { const sig = await send(new Transaction().add(...withCu(600_000)).add(ix()), signers); console.log(`  ${label}: OK (${sig.slice(0,8)}…)`); return true; }
  catch (e: any) { const m = (e.message||"").split("\n")[0]; const code = (e.logs||[]).join(" ").match(/custom program error: (0x[0-9a-f]+)/)?.[1] || m; console.log(`  ${label}: REJECTED (${code})`); return false; }
}

async function main() {
  console.log("program:", PROGRAM_ID.toBase58(), "admin:", admin.publicKey.toBase58());
  const market = Keypair.generate(), portA = Keypair.generate(), portB = Keypair.generate();
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);

  await send(new Transaction().add(...withCu(60_000))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey, lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
    [admin, market, portA, portB]);
  console.log("created market + portA + portB");

  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: NATIVE_MINT, isSigner: false, isWritable: false }],
    data: encInitMarket({ maxPortfolioAssets: 4, hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n, minNonzeroMmReq: 500n, minNonzeroImReq: 600n, maintenanceMarginBps: 500n, initialMarginBps: 500n, maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n, liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n, minLiquidationAbs: 0n, maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n, maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n, maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n, maxBankruptCloseLifetimeSlots: 10_000_000n, publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 58n }) })), [admin]);
  const slot0 = BigInt(await conn.getSlot("confirmed"));
  await send(new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n, markEwmaHalflifeSlots: 300n, markMinFee: 500n }) })), [admin]);
  // short force-close delay
  await send(new Transaction().add(...withCu(200_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigurePermissionlessResolve({ staleSlots: 100n, forceCloseDelaySlots: 5n }) })), [admin]);
  console.log("InitMarket + hyperp asset 0 + force_close_delay=5");

  // wrap + deposit
  await send(new Transaction().add(...withCu(50_000))
    .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
    .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, sourceAta, admin.publicKey, NATIVE_MINT))
    .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 1_000_000_000 }))
    .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }), [admin]);
  for (const p of [portA, portB]) {
    await send(new Transaction().add(...withCu(300_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }], data: encInitPortfolio() })), [admin]);
    await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }, { pubkey: sourceAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encDeposit(300_000_000n) })), [admin]);
  }
  console.log("portA + portB initialized + funded");

  // open opposing positions (portA long 10M, portB short 10M)
  const tradeKeys = [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portA.publicKey, isSigner: false, isWritable: true }, { pubkey: portB.publicKey, isSigner: false, isWritable: true }];
  await send(new Transaction().add(...withCu(600_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: tradeKeys, data: encTradeNoCpi({ assetIndex: 0, sizeQ: 10_000_000n, execPrice: 1_000_000n, feeBps: 1n }) })), [admin]);
  console.log("opened: portA long 10M, portB short 10M");

  // resolve
  await send(new Transaction().add(...withCu(400_000)).add(new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encResolveMarket() })), [admin]);
  console.log("ResolveMarket done (mode->1)\n");

  const adminAta = sourceAta;
  const closeIx = (p: PublicKey) => new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p, isSigner: false, isWritable: true },
    { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encCloseResolved(0n) });

  console.log("TEST A — CloseResolved(portA) with an OPEN position, right after resolve:");
  await tryClose("CloseResolved(portA) [open position]", () => closeIx(portA.publicKey), [admin]);

  console.log(`\nwaiting force_close_delay (~5 slots)…`);
  await new Promise(r => setTimeout(r, 6000));

  console.log("TEST B — CloseResolved(portA) after the delay (still has open position):");
  await tryClose("CloseResolved(portA) [open, post-delay]", () => closeIx(portA.publicKey), [admin]);

  console.log("\nTEST C — owner-signed flatten then close: RebalanceReduce(portA) -> CloseResolved(portA):");
  const flat = await tryClose("RebalanceReduce(portA, 10M) [owner=admin signs]", () => new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: portA.publicKey, isSigner: false, isWritable: true }], data: encRebalanceReduce({ assetIndex: 0, reduceQ: 10_000_000n }) }), [admin]);
  if (flat) await tryClose("CloseResolved(portA) [now flat]", () => closeIx(portA.publicKey), [admin]);

  console.log("\n=== CONCLUSION ===");
  console.log("If A/B were REJECTED and C succeeded: CloseResolved requires a FLAT portfolio,");
  console.log("and flattening (RebalanceReduce) requires the OWNER's signature (owner_must_sign=true).");
  console.log("=> admin can force-close a FLAT foreign account post-delay, but CANNOT force-close a");
  console.log("   foreign account that holds an OPEN position (only its owner can flatten it).");
}
main().catch(e => { console.error("FATAL:", e.message || e); if (e.logs) console.error(e.logs.slice(-8).join("\n")); process.exit(1); });
