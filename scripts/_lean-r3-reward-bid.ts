/** EV+ lazy bidder for the round-3.1 wSOL buy-and-burn reward auction.
 *  Runs one full epoch (StartEpoch -> SubmitBid -> SettleEpoch -> ClaimQuote) ONLY when it is
 *  net profitable: picks the sole-bidder profit-maximizing wSOL bid b* = sqrt(Q*Bvirt*1e3/P) - Bvirt
 *  (payout = Q*b/(b+Bvirt)), and fires only if claimed USDC - burned wSOL - epoch rent - fees > MIN_NET.
 *  Dry by default (prints the decision, no tx). Pass --live to execute. bidder = funder. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, createSyncNativeInstruction, NATIVE_MINT, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import { rewardStartEpoch, rewardSubmitBid, rewardSettleEpoch, rewardClaimQuote, deriveDexVault, EPOCH_SIZE, BIDDER_SIZE } from "../src/lean/index.js";

const LIVE = process.argv.includes("--live");
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync("lean-mainnet-r3.json", "utf8"));
const RM = new PublicKey(m.rewardModule), P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MKT = new PublicKey(m.market);
const CFG = new PublicKey(m.rewardCfg), USDC = new PublicKey(m.usdc);
const quoteVault = new PublicKey(m.quoteVault), targetEscrow = new PublicKey(m.targetEscrow), burnSink = new PublicKey(m.burnSink);
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const U = (n: bigint) => (Number(n) / 1e6).toFixed(6);
const MIN_NET_USD = 0.20;        // require at least this much net profit to bother
const EPOCH_RENT_SOL = 0.0016;   // ~rent for the per-epoch 104B account (non-recovered)

const g = (b: Buffer, o: number) => b.readBigUInt64LE(o);
async function acct(pk: PublicKey) { const i = await conn.getAccountInfo(pk, "confirmed"); return i ? Buffer.from(i.data) : null; }
async function solPriceUsd(): Promise<number> { try { const r: any = await (await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")).json(); return parseFloat(r.data.amount); } catch { return 130; } }
async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...signers], { commitment: "confirmed" }); } catch (e) { const s = String((e as Error).message ?? e); if (i < 5 && /429|Too Many|rate|block height|timed out|not found/i.test(s)) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; } throw e; } }
}

async function main() {
  const mkt = (await acct(MKT))!, cfg = (await acct(CFG))!;
  const accrued = g(mkt, 360);                        // rewardAccrued (will be pulled into the pot)
  const rollover = g(cfg, 368);                        // rolloverQuote carried from prior epochs
  const reserveRateE6 = g(cfg, 344);
  const minBatch = g(cfg, 336);
  const activeEpoch = cfg.subarray(296, 328).some(x => x !== 0);
  const P_sol = await solPriceUsd();
  const Q = accrued + rollover;                        // projected pot (USDC 1e6 units)
  const Bvirt = (Q * reserveRateE6 + 999_999n) / 1_000_000n; // ceil(Q*rate/1e6)
  // profit-max sole bid b* (atoms): d/db [Q*b/(b+Bvirt)/1e6 - b/1e9*P] = 0  ->  b* = sqrt(Q*Bvirt*1e3/P) - Bvirt
  const bstarF = Math.sqrt(Number(Q) * Number(Bvirt) * 1000 / P_sol) - Number(Bvirt);
  const bStar = BigInt(Math.max(1, Math.floor(bstarF)));
  const payoutUsd = Number(Q * bStar / (bStar + Bvirt)) / 1e6;
  const burnUsd = Number(bStar) / 1e9 * P_sol;
  const netUsd = payoutUsd - burnUsd - EPOCH_RENT_SOL * P_sol;  // tx fees ~negligible
  console.log(`[reward-bid] accrued=$${U(accrued)} rollover=$${U(rollover)} -> Q=$${U(Q)} | reserveRateE6=${reserveRateE6} Bvirt=${Bvirt} | SOL=$${P_sol.toFixed(2)} activeEpoch=${activeEpoch}`);
  console.log(`[reward-bid] optimal bid b*=${(Number(bStar) / 1e9).toFixed(6)} SOL -> claim $${payoutUsd.toFixed(4)} | burn $${burnUsd.toFixed(4)} | net(after epoch rent) $${netUsd.toFixed(4)}`);

  if (activeEpoch) { console.log("[reward-bid] an epoch is already active — skipping (settle/claim it first)."); return; }
  if (Q < minBatch) { console.log(`[reward-bid] SKIP: pot $${U(Q)} < minBatch $${U(minBatch)}.`); return; }
  if (netUsd < MIN_NET_USD) { console.log(`[reward-bid] SKIP: net $${netUsd.toFixed(4)} < MIN_NET $${MIN_NET_USD}. (waiting for a bigger pot / lower reserve)`); return; }
  if (!LIVE) { console.log(`[reward-bid] DRY: would fire this epoch (net +$${netUsd.toFixed(4)}). Re-run with --live to execute.`); return; }

  // ---- LIVE: run the full epoch ----
  const bidder = funder; // bidder = funder, reuse funder ATAs
  const wsolAta = (await getOrCreateAssociatedTokenAccount(conn, funder, NATIVE_MINT, funder.publicKey)).address;
  const usdcAta = await getAssociatedTokenAddress(USDC, funder.publicKey);
  const dexVault = deriveDexVault(P, DEX)[0];
  // 1) StartEpoch (fresh epoch account)
  const epoch = Keypair.generate();
  const rentE = await conn.getMinimumBalanceForRentExemption(EPOCH_SIZE);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: epoch.publicKey, lamports: rentE, space: EPOCH_SIZE, programId: RM })], [epoch]);
  await send([rewardStartEpoch(RM, { cfg: CFG, epochAcc: epoch.publicKey, dex: DEX, market: MKT, quoteMint: USDC, dexVault, quoteVault, percolator: P })]);
  const ep = (await acct(epoch.publicKey))!;
  const Qr = g(ep, 48), Bv = g(ep, 56);                 // real pot + virtBids after StartEpoch
  const bF = Math.sqrt(Number(Qr) * Number(Bv) * 1000 / P_sol) - Number(Bv);
  const bid = BigInt(Math.max(1, Math.floor(bF)));
  const realPayout = Number(Qr * bid / (bid + Bv)) / 1e6, realBurn = Number(bid) / 1e9 * P_sol;
  console.log(`[reward-bid] LIVE epoch: Q=$${U(Qr)} Bvirt=${Bv} -> bid ${(Number(bid) / 1e9).toFixed(6)} SOL, expect claim $${realPayout.toFixed(4)} burn $${realBurn.toFixed(4)}`);
  if (realPayout - realBurn <= 0) { console.log("[reward-bid] ABORT after StartEpoch: bid not EV+ at live Q/Bvirt (quote rolls over, no loss)."); return; }
  // 2) wrap b* SOL into funder wSOL ATA, SubmitBid
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: wsolAta, lamports: Number(bid) }), createSyncNativeInstruction(wsolAta)]);
  const bidReceipt = Keypair.generate();
  const rentB = await conn.getMinimumBalanceForRentExemption(BIDDER_SIZE);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: bidReceipt.publicKey, lamports: rentB, space: BIDDER_SIZE, programId: RM })], [bidReceipt]);
  await send([rewardSubmitBid(RM, { cfg: CFG, epochAcc: epoch.publicKey, bidReceipt: bidReceipt.publicKey, bidder: bidder.publicKey, bidderTargetTok: wsolAta, targetEscrow, targetMint: NATIVE_MINT, amount: bid })], [bidder]);
  // 3) wait epochSlots, SettleEpoch (burn)
  const endSlot = (await conn.getSlot("confirmed")) + Number(g(cfg, 328)) + 3;
  while ((await conn.getSlot("confirmed")) < endSlot) await new Promise(r => setTimeout(r, 1500));
  await send([rewardSettleEpoch(RM, { cfg: CFG, epochAcc: epoch.publicKey, targetEscrow, targetMint: NATIVE_MINT, burnSink, burnMode: 1 })]);
  // 4) ClaimQuote (receive USDC; auto-closes bidReceipt, refunds its rent)
  const before = (await getAccount(conn, usdcAta)).amount;
  await send([rewardClaimQuote(RM, { cfg: CFG, epochAcc: epoch.publicKey, bidReceipt: bidReceipt.publicKey, bidder: bidder.publicKey, quoteVault, bidderQuoteTok: usdcAta, quoteMint: USDC })], [bidder]);
  const got = (await getAccount(conn, usdcAta)).amount - before;
  console.log(`[reward-bid] DONE: claimed $${(Number(got) / 1e6).toFixed(6)} USDC for ${(Number(bid) / 1e9).toFixed(6)} wSOL burned (buy-and-burn). net ~$${(Number(got) / 1e6 - realBurn - EPOCH_RENT_SOL * P_sol).toFixed(4)}`);
}
main().then(() => process.exit(0)).catch(e => { console.error("[reward-bid] ERR", String(e).slice(0, 300)); process.exit(1); });
