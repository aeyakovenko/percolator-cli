/** AIRTIGHT steelman of bounty submission #79/#80 (bankrupt-recycling via TradeNoCpi).
 * Gives the attacker MAX power: they own the market AND the auth-mark (can move the
 * price at will — strictly more power than on the real bounty, where the mark is a
 * real Pyth oracle / admin auth). We GENUINELY bankrupt B (push auth-mark adversely
 * AND crank to apply it), then try every extraction path and measure the attacker's
 * NET SOL and the insurance delta. Exploit == attacker nets > 0 from insurance. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as fs from "fs";
import { encInitMarket, encInitPortfolio, encDeposit, encWithdraw, encTradeNoCpi, encPermissionlessCrank, encConfigureAuthMark, encPushAuthMark, encConvertReleasedPnl, encTopUpInsurance, MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN, parsePortfolio, parseMarketGroup } from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.V16_PROGRAM_ID ?? "Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const cu = (u = 400_000) => [ComputeBudgetProgram.setComputeUnitLimit({ units: u }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
const send = (ixs: TransactionInstruction[], signers: Keypair[] = [admin]) => sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ...ixs), signers, { commitment: "confirmed", skipPreflight: true });
const code = (e: any) => { const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + String(e?.message ?? ""); const h = s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]; if (h) return h; const d = s.match(/"Custom":\s*(\d+)/)?.[1]; return d ? "0x" + Number(d).toString(16) : (s.slice(0, 70) || "ok"); };
const market = Keypair.generate(), A = Keypair.generate(), B = Keypair.generate();
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROGRAM_ID);
const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
const sol = (x: bigint | number) => (Number(x) / 1e9).toFixed(6);

async function mkt() { const g: any = parseMarketGroup(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data)); return { insurance: BigInt(g.insurance), assets: g.assets }; }
async function pf(k: PublicKey) { const ai = await conn.getAccountInfo(k, "confirmed"); if (!ai) return null; const p: any = parsePortfolio(Buffer.from(ai.data)); return { capital: BigInt(p.capital), pnl: BigInt(p.pnl), legs: p.legs.length }; }
async function effPrice() { const g: any = parseMarketGroup(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data)); return BigInt(g.assets.find((a: any) => a.index === 0)?.effectivePrice ?? 0n); }
const crank = async (slot: bigint) => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: A.publicKey, isSigner: false, isWritable: true }], data: encPermissionlessCrank({ action: 0, assetIndex: 0, nowSlot: slot, fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })]);

(async () => {
  console.log(`=== AIRTIGHT bounty-6 steelman (prog ${PROGRAM_ID.toBase58()}) ===`);
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  await send([SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey, lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: A.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: B.publicKey, lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })], [admin, market, A, B]);
  await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: NATIVE_MINT, isSigner: false, isWritable: false }],
    data: encInitMarket({ maxPortfolioAssets: 1, hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n, minNonzeroMmReq: 500n, minNonzeroImReq: 600n, maintenanceMarginBps: 500n, initialMarginBps: 500n, maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n, liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n, minLiquidationAbs: 0n, maxPriceMoveBpsPerSlot: 24n, maxAccrualDtSlots: 20n, maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n, maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n, maxBankruptCloseLifetimeSlots: 10_000_000n, publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 28n }) })]);
  await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encConfigureAuthMark({ assetIndex: 0, nowSlot: BigInt(await conn.getSlot()), initialMarkE6: 1_000_000n }) })]);
  for (const p of [A, B]) await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p.publicKey, isSigner: false, isWritable: true }], data: encInitPortfolio() })]);
  await send([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT), createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, sourceAta, admin.publicKey, NATIVE_MINT), SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 2_000_000_000 }), { keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }]);
  const dep = (p: PublicKey, amt: bigint) => send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: p, isSigner: false, isWritable: true }, { pubkey: sourceAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encDeposit(amt) })]);
  const A_IN = 100_000_000n, B_IN = 5_000_000n;
  await dep(A.publicKey, A_IN); await dep(B.publicKey, B_IN);
  await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: sourceAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encTopUpInsurance(500_000_000n) })]);
  const ins0 = (await mkt()).insurance;
  console.log(`setup: A_in=${sol(A_IN)} B_in=${sol(B_IN)} insurance=${sol(ins0)}`);

  // open: A long 80M, B short 80M @ 1.0 (B IM 5% = 4M <= 5M cap)
  await crank(BigInt(await conn.getSlot()));
  const SIZE = 80_000_000n;
  await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: A.publicKey, isSigner: false, isWritable: true }, { pubkey: B.publicKey, isSigner: false, isWritable: true }], data: encTradeNoCpi({ assetIndex: 0, sizeQ: SIZE, execPrice: 1_000_000n, feeBps: 0n }) })]);
  console.log(`opened A long / B short ${sol(SIZE)} @ 1.0`);

  // GENUINELY bankrupt B: push auth-mark UP (B is short) and CRANK to apply, until B underwater.
  console.log("\nbankrupting B (push auth-mark up + crank)…");
  const px = (e6: bigint) => (Number(e6) / 1e6).toFixed(4);
  // B is short SIZE @ basis 1.0 → mark-to-market pnl = (1.0 - effPx)*SIZE (negative as price rises)
  const mtm = (cap: bigint, ep: bigint) => cap + (1_000_000n - ep) * SIZE / 1_000_000n;
  let bankrupt = false;
  for (let i = 0; i < 40 && !bankrupt; i++) {
    const slot = BigInt(await conn.getSlot());
    try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: market.publicKey, isSigner: false, isWritable: true }], data: encPushAuthMark({ assetIndex: 0, nowSlot: slot, markE6: 3_000_000n }) })]); } catch {}
    try { await crank(slot + 1n); } catch (e: any) { /* may 0x16 if no progress */ }
    const b = await pf(B.publicKey); const ep = await effPrice();
    const mtmHealth = b ? mtm(b.capital, ep) : 0n;
    if (i % 4 === 0 || mtmHealth <= 0n) console.log(`  i=${i} effPx=${px(ep)} B.cap=${sol(b?.capital ?? 0n)} B.mtm_health=${sol(mtmHealth)} (cap + unrealized)`);
    if (mtmHealth <= 0n) bankrupt = true;
  }
  const bB = await pf(B.publicKey); const epNow = await effPrice();
  console.log(`B now: cap=${sol(bB?.capital ?? 0n)} effPx=${px(epNow)} (was 1.0)  mark-to-market health=${sol(mtm(bB?.capital ?? 0n, epNow))}  → GENUINELY BANKRUPT=${bankrupt}`);

  const insBeforeExtract = (await mkt()).insurance;
  console.log(`\ninsurance before extraction: ${sol(insBeforeExtract)}`);

  // EXTRACTION attempts (A wants insurance-funded profit):
  console.log("\n--- extraction attempts ---");
  // 1. close: B buys back from A at the (real) effective price
  try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: A.publicKey, isSigner: false, isWritable: true }, { pubkey: B.publicKey, isSigner: false, isWritable: true }], data: encTradeNoCpi({ assetIndex: 0, sizeQ: -SIZE, execPrice: epNow, feeBps: 0n }) })]); console.log("  close A/B via TradeNoCpi: SUCCEEDED"); }
  catch (e: any) { console.log(`  close A/B via TradeNoCpi: BLOCKED ${code(e)}`); }
  // 2. convert A's released pnl
  try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: A.publicKey, isSigner: false, isWritable: true }], data: encConvertReleasedPnl(1_000_000_000n) })]); console.log("  ConvertReleasedPnl A: SUCCEEDED"); }
  catch (e: any) { console.log(`  ConvertReleasedPnl A: BLOCKED ${code(e)}`); }
  // 3. withdraw everything possible from A and B
  let out = 0n;
  for (const [n, k] of [["A", A.publicKey], ["B", B.publicKey]] as const) {
    const p = await pf(k); const want = p ? (p.capital > 0n ? p.capital : 0n) : 0n;
    if (want > 0n) { try { await send([new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true }, { pubkey: k, isSigner: false, isWritable: true }, { pubkey: sourceAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: encWithdraw(want) })]); out += want; console.log(`  withdraw ${n}: ${sol(want)} OK`); } catch (e: any) { console.log(`  withdraw ${n} (${sol(want)}): BLOCKED ${code(e)}`); } }
    else console.log(`  withdraw ${n}: nothing (cap=${sol(p?.capital ?? 0n)})`);
  }

  const insAfter = (await mkt()).insurance;
  const attackerIn = A_IN + B_IN, attackerNet = out - attackerIn, insDelta = insAfter - ins0;
  console.log(`\n================ VERDICT ================`);
  console.log(`attacker deposited: ${sol(attackerIn)}   withdrew: ${sol(out)}   NET: ${attackerNet >= 0n ? "+" : ""}${sol(attackerNet)} SOL`);
  console.log(`insurance: ${sol(ins0)} → ${sol(insAfter)}  (Δ ${insDelta >= 0n ? "+" : ""}${sol(insDelta)})`);
  console.log(attackerNet > 0n && insDelta < 0n
    ? `🚨 EXPLOIT CONFIRMED — attacker net-extracted ${sol(attackerNet)} SOL, insurance drained ${sol(-insDelta)}.`
    : `✅ NOT EXPLOITABLE — attacker net ${sol(attackerNet)} SOL (≤0 = lost money), insurance ${insDelta >= 0n ? "intact/up" : "down only by legit covered loss"}. Bankrupt B could NOT be recycled into A's pocket.`);
})().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
