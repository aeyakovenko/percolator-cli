/**
 * Create the LIVE mainnet bug-bounty market and seed the insurance prize (USDC).
 *   SOLANA_RPC_URL=<mainnet helius> pnpm tsx scripts/lean-mainnet-bounty.ts
 *
 * - DEX with USDC (6-decimal) collateral
 * - SOL/USD market priced by the live Pyth feed via oracle_adapter
 * - seed insurance with ~70 USDC (= the swapped 1 SOL) as the prize pot
 * Writes the addresses to lean-mainnet.json. Real money.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs";
import {
  LEAN_MAINNET, DEX_SIZE, MARKET_SIZE, INS_RECEIPT_SIZE, ADAPTER_CFG_SIZE, POS_SCALE, FEED_TYPE,
  deriveOracleAuth, deriveDexVault, initDex, createMarket, adapterInit, adapterCrank, depositInsurance,
  parseDex, parseMarket, parseInsReceipt, type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_MAINNET.percolator, O = LEAN_MAINNET.oracleAdapter;
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const PRIZE = 70n * POS_SCALE; // 70 USDC

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [funder, ...signers], { commitment: "confirmed" }); } catch (e) { const m = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|rate|timed out|block height/i.test(m)) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; } throw e; } }
}
async function newAcc(owner: PublicKey, size: number) {
  const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(size);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: size, programId: owner })], [kp]);
  return kp.publicKey;
}
async function freshSolFeed() {
  const r = await conn.getProgramAccounts(RECEIVER, { commitment: "confirmed", filters: [{ memcmp: { offset: 41, bytes: bs58.encode(Buffer.from(SOL_FEED, "hex")) } }] });
  let best: any = null; const now = Math.floor(Date.now() / 1000);
  for (const { pubkey, account } of r) { const d = account.data; if (d.length < 134 || d[40] !== 1) continue; const price = d.readBigInt64LE(73), expo = d.readInt32LE(89), age = now - Number(d.readBigInt64LE(93)); if (price <= 0n) continue; const sh = expo + 6; const e6 = sh >= 0 ? price * 10n ** BigInt(sh) : price / 10n ** BigInt(-sh); if (!best || age < best.age) best = { addr: pubkey, e6, age }; }
  return best;
}

async function main() {
  if (!conn.rpcEndpoint.includes("mainnet") && !conn.rpcEndpoint.includes("helius")) throw new Error("mainnet RPC required");
  const usdcAtas = await conn.getParsedTokenAccountsByOwner(funder.publicKey, { mint: USDC }, "confirmed");
  if (!usdcAtas.value.length) throw new Error("no USDC token account");
  const usdcAta = usdcAtas.value[0].pubkey;
  const haveUsdc = BigInt(usdcAtas.value[0].account.data.parsed.info.tokenAmount.amount);
  console.log(`USDC ATA ${usdcAta.toBase58()} balance ${Number(haveUsdc) / 1e6} USDC; prize = ${Number(PRIZE) / 1e6} USDC`);
  if (haveUsdc < PRIZE) throw new Error("insufficient USDC for prize");
  const feed = await freshSolFeed();
  console.log(`live Pyth SOL/USD ${feed.addr.toBase58()} = $${Number(feed.e6) / 1e6} (age ${feed.age}s)`);

  // DEX (USDC collateral)
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint: USDC, feeVault: usdcAta, decimals: 6, createFee: 0n })]);
  const d = parseDex(Buffer.from((await conn.getAccountInfo(dex))!.data));
  const V: VaultAccounts = { dex, mint: USDC, vault: d.vault };
  const [vault] = deriveDexVault(P, dex);
  console.log(`DEX ${dex.toBase58()} vault ${vault.toBase58()}`);

  // SOL/USD market via live Pyth adapter
  const cfg = await newAcc(O, ADAPTER_CFG_SIZE);
  const [oracPda] = deriveOracleAuth(O, cfg);
  const init = feed.e6 - feed.e6 / 100n;
  const params: MarketParams = { initPrice: init, exitWindow: 10n, maxStaleness: 9000n, warmupSlots: 0n, imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n, maxMoveBps: 400n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint: USDC, oracleAuth: oracPda, creator: funder.publicKey, creatorToken: usdcAta, feeVault: usdcAta, params })]);
  await send([adapterInit(O, { cfg, admin: funder.publicKey, percolator: P, market: mkt, feed: feed.addr, feedType: FEED_TYPE.PYTH_V2, maxFeedAge: 600n, maxConfBps: 500n, fundingBpsPerStep: 0n, feedId: Buffer.from(SOL_FEED, "hex") })]);
  await send([adapterCrank(O, { cfg, market: mkt, feed: feed.addr, percolator: P })]);
  const mk = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  console.log(`MARKET ${mkt.toBase58()} (SOL/USD) mark=$${Number(mk.markPrice) / 1e6}, adapterCfg ${cfg.toBase58()}`);

  // seed insurance prize (depositor holds the InsReceipt so an UNCLAIMED bounty is reclaimable; a real exploit still extracts it)
  const receipt = await newAcc(P, INS_RECEIPT_SIZE);
  await send([depositInsurance(P, V, { market: mkt, receipt, lp: funder.publicKey, sourceToken: usdcAta, amount: PRIZE })]);
  const rc = parseInsReceipt(Buffer.from((await conn.getAccountInfo(receipt))!.data));
  const m2 = parseMarket(Buffer.from((await conn.getAccountInfo(mkt))!.data));
  const vaultBal = (await conn.getTokenAccountBalance(vault, "confirmed")).value.uiAmountString;
  console.log(`SEEDED insurance: market.insurance=${Number(m2.insurance) / 1e6} USDC, vault SPL balance=${vaultBal} USDC, InsReceipt ${receipt.toBase58()} shares=${rc.shares}`);

  // write addresses
  const mani = JSON.parse(fs.readFileSync("lean-mainnet.json", "utf8"));
  mani.bountyMarket = {
    dex: dex.toBase58(), market: mkt.toBase58(), vault: vault.toBase58(), adapterCfg: cfg.toBase58(),
    insReceipt: receipt.toBase58(), collateral: "USDC " + USDC.toBase58(), oracle: "Pyth SOL/USD " + feed.addr.toBase58(),
    insuranceUsdc: Number(m2.insurance) / 1e6, note: "Break it & keep the USDC: drain the insurance / violate V==SPL.",
  };
  delete mani.bountyPot;
  fs.writeFileSync("lean-mainnet.json", JSON.stringify(mani, null, 2) + "\n");
  console.log("\nLIVE BOUNTY MARKET:\n  dex     " + dex.toBase58() + "\n  market  " + mkt.toBase58() + "\n  vault   " + vault.toBase58() + "\n  prize   " + Number(m2.insurance) / 1e6 + " USDC");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 600)); process.exit(1); });
