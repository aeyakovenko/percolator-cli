/**
 * Trade-validate an ALREADY-DEPLOYED v16 bounty-5 market group (open+close on all
 * 3 assets) without re-creating the market. Targets the live market from the
 * manifest. Fixes the two robustness issues seen on the mainnet deploy:
 *   - ATOMIC create+init+deposit per portfolio (one tx) → no InitPortfolio→Deposit race
 *   - robust CATCH-UP crank loop → crank until slot_last is within max_accrual_dt
 *     (each accrual advances ≤ max_accrual_dt; a long idle asset needs several)
 *
 *   NETWORK=mainnet MARKET=<pubkey> V16_PROGRAM_ID=<id> tsx scripts/smoke-mainnet-bounty5-trades.ts
 *   (defaults read mainnet-bounty5-v16-market.json)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitPortfolio, encDeposit, encWithdraw, encClosePortfolio,
  encTradeNoCpi, encPermissionlessCrank,
  PORTFOLIO_ACCOUNT_LEN, PORTFOLIO_STATE_OFF, PA,
} from "../src/v16/index.js";

const HOME = process.env.HOME!;
const NETWORK = (process.env.NETWORK ?? "mainnet").toLowerCase();
const RPC = NETWORK === "mainnet"
  ? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`
  : (process.env.SOLANA_RPC_URL ?? fs.readFileSync(`${HOME}/percolator-cli/.env`, "utf8").trim().split("=").slice(1).join("="));
const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const PROGRAM_ID = new PublicKey(process.env.V16_PROGRAM_ID ?? M.programId);
const MARKET = new PublicKey(process.env.MARKET ?? M.market);
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));

const MAX_ACCRUAL_DT = 20n;
const TRADE_SIZE = 1_000_000n;        // 1 POS_SCALE
const DEPOSIT = 300_000_000n;

// asset oracle accounts (mainnet = devnet PDAs)
const SOL = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const EUR = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const BTC = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
const ASSETS = [
  { idx: 0, label: "USD/SOL",   accts: [SOL] },
  { idx: 1, label: "STOXX/SOL", accts: [STOXX, EUR, SOL] },
  { idx: 2, label: "BTC/SOL",   accts: [BTC, SOL] },
];

const withCu = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROGRAM_ID)[0];
const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
const send = (ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...withCu(), ...ixs), signers, { commitment: "confirmed", skipPreflight });
// wait until an account is visible at "confirmed" (kills the InitPortfolio→Deposit race)
async function waitExists(pk: PublicKey) {
  for (let i = 0; i < 30; i++) { if (await conn.getAccountInfo(pk, "confirmed")) return; await new Promise((r) => setTimeout(r, 400)); }
  throw new Error(`account ${pk.toBase58()} never appeared`);
}

let pass = 0, fail = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try { const r = await fn(); console.log(`  ✅  ${name}`); pass++; return r; }
  catch (e: any) {
    const code = (e.transactionLogs ?? e.logs ?? []).join(" ").match(/custom program error: (0x[0-9a-f]+)/)?.[1] ?? (e.message || "").slice(0, 70);
    console.log(`  ❌  ${name}: ${code}`); fail++; return null;
  }
}

// engine AssetState lives at slot_off + ASSET_ORACLE_WRAPPER_LEN
async function assetState(idx: number): Promise<{ mark: bigint; slotLast: bigint }> {
  const { parseAsset } = await import("../src/v16/parsers.js");
  const { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN } = await import("../src/v16/constants.js");
  const buf = Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data);
  const off = MARKET_GROUP_OFF + MG.asset_slots + idx * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
  const a: any = parseAsset(buf, off, idx);
  return { mark: a.effectivePrice as bigint, slotLast: a.slotLast as bigint };
}

function crankIx(idx: number, accts: PublicKey[], slot: bigint, portA: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: portA, isSigner: false, isWritable: true },
      ...accts.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
    ],
    data: encPermissionlessCrank({ action: 0, assetIndex: idx, nowSlot: slot, fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
  });
}

// Crank until the asset's slot_last is within max_accrual_dt of the current slot.
async function catchUp(a: typeof ASSETS[number], portA: PublicKey): Promise<bigint> {
  for (let i = 0; i < 10; i++) {
    const cur = BigInt(await conn.getSlot("confirmed"));
    const { slotLast } = await assetState(a.idx);
    if (slotLast > 0n && cur - slotLast <= MAX_ACCRUAL_DT) break;
    await send([crankIx(a.idx, a.accts, cur, portA)], [admin]);
  }
  // one final fresh crank so the mark is current, then read it
  const cur = BigInt(await conn.getSlot("confirmed"));
  await send([crankIx(a.idx, a.accts, cur, portA)], [admin]);
  return (await assetState(a.idx)).mark;
}

async function main() {
  console.log(`trade-smoke ${NETWORK}  market=${MARKET.toBase58()}  prog=${PROGRAM_ID.toBase58()}`);
  const portA = Keypair.generate(), portB = Keypair.generate();
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);

  // wrap SOL for deposits
  await step("wrap SOL + vault ATA", () => send([
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, sourceAta, admin.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: Number(DEPOSIT) * 2 + 20_000_000 }),
    { keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) },
  ], [admin]));

  // SEPARATE create → init → deposit (preflight on), waiting for the account to be
  // visible between init and deposit — the deploy validator's proven flow.
  await step("create portfolios A+B", () => send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }),
  ], [admin, portA, portB]));
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    await step(`InitPortfolio ${n}`, () => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true },
    ], data: encInitPortfolio() })], [admin]));
    await waitExists(p.publicKey);
    await step(`Deposit ${n}`, () => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: encDeposit(DEPOSIT) })], [admin]));
  }

  const tradeKeys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: portA.publicKey, isSigner: false, isWritable: true }, { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ];
  const trade = (idx: number, size: bigint, price: bigint) => send([new TransactionInstruction({
    programId: PROGRAM_ID, keys: tradeKeys, data: encTradeNoCpi({ assetIndex: idx, sizeQ: size, execPrice: price, feeBps: 0n }),
  })], [admin]);

  const result: Record<string, string> = {};
  for (const a of ASSETS) {
    console.log(`\n--- m${a.idx} (${a.label}) ---`);
    let ok = true;
    const om = await catchUp(a, portA.publicKey);
    if (!(await step(`OPEN m${a.idx} +${TRADE_SIZE} @ ${om}`, () => trade(a.idx, TRADE_SIZE, om)))) ok = false;
    const cm = await catchUp(a, portA.publicKey);
    if (!(await step(`CLOSE m${a.idx} -${TRADE_SIZE} @ ${cm}`, () => trade(a.idx, -TRADE_SIZE, cm)))) ok = false;
    result[`m${a.idx}`] = ok ? "PASS" : "FAIL";
    console.log(`  >>> m${a.idx} ${a.label}: ${ok ? "✅ PASS" : "❌ FAIL"}`);
  }

  console.log("\n=== teardown ===");
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    const cap = await (async () => { const buf = (await conn.getAccountInfo(p.publicKey, "confirmed"))!.data; const o = PORTFOLIO_STATE_OFF + PA.capital; return buf.readBigUInt64LE(o) | (buf.readBigUInt64LE(o + 8) << 64n); })().catch(() => 0n);
    if (cap > 0n) await step(`withdraw ${n}`, () => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: encWithdraw(cap) })], [admin]));
    await step(`close ${n}`, () => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: MARKET, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true },
    ], data: encClosePortfolio() })], [admin]));
  }

  console.log(`\n===== PASS ${pass} / FAIL ${fail} =====`);
  for (const a of ASSETS) console.log(`  m${a.idx} ${a.label.padEnd(12)} ${result[`m${a.idx}`] ?? "?"}`);
}
main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
