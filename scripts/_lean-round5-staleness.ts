/**
 * ROUND-5 REHEARSAL — maxStaleness rehearsal (150 / 300 / 900 slots).
 *
 * For each candidate maxStaleness it reports:
 *   - keeper heartbeat cadence + cost (pushes/hour, SOL/day) at heartbeatFraction 0.4;
 *   - how long a keeper OUTAGE the market survives before the oracle goes stale (trades revert
 *     oracleStale 106) and — critically — before ANY attacker can permissionlessly StartWindDown
 *     (IRREVERSIBLE: handleStartWindDown is permissionless once oracle age > maxStaleness);
 *   - a recommendation (slots ~213 ms mainnet / ~240 ms devnet).
 * Measures the REAL devnet slot time, and (empirically, at maxStaleness=150) the real heartbeat push
 * cost, the outage-to-oracleStale timing, and the permissionless wind-down.
 *
 *   LEAN_RPC_URL=<devnet rpc> npx -y tsx scripts/_lean-round5-staleness.ts
 * DEVNET ONLY.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import {
  LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, POS_SCALE, TRADE_MODE,
  initDex, createMarket, updateOracle, initPortfolio, depositCollateral, trade, refreshLeg, startWindDown,
  packFundingCfg, assertDevnet, deriveDexVault, parseMarket, heartbeatAgeSlots, alarmAgeSlots, maskSecrets,
  type MarketParams, type VaultAccounts,
} from "../src/lean/index.js";

const RPC = process.env.LEAN_RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const P = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const MAINNET_SLOT_MS = 213, HEARTBEAT_FRACTION = 0.4;
const CCANDIDATES = [150n, 300n, 900n];

const say = (s: string) => console.log(maskSecrets(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const e6 = (p: number) => BigInt(Math.round(p * 1e6));
let nonce = 1;
const uniq = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: nonce++ });
async function send(ixs: TransactionInstruction[], s: Keypair[] = []) {
  for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(uniq(), ...ixs), [funder, ...s], { commitment: "confirmed" }); }
    catch (e) { if (i < 6 && /429|Too Many|block height|timed out|fetch failed|not found/i.test(String(e))) { await sleep(1500 * (i + 1)); continue; } throw e; } }
}
async function newAcc(o: PublicKey, sz: number) { const kp = Keypair.generate(); const lam = await conn.getMinimumBalanceForRentExemption(sz); await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space: sz, programId: o })], [kp]); return kp.publicKey; }
const mktOf = async (m: PublicKey) => parseMarket(Buffer.from((await conn.getAccountInfo(m, "confirmed"))!.data));

async function measureSlotMs(samples = 30): Promise<number> {
  const s0 = await conn.getSlot("confirmed"); const t0 = Date.now();
  while ((await conn.getSlot("confirmed")) < s0 + samples) await sleep(300);
  const s1 = await conn.getSlot("confirmed"); const t1 = Date.now();
  return (t1 - t0) / (s1 - s0);
}

function analytic(maxStale: bigint, slotMs: number) {
  const hbAge = heartbeatAgeSlots(maxStale, HEARTBEAT_FRACTION);   // push when age >= 0.4 x maxStale
  const alarm = alarmAgeSlots(maxStale);                           // 0.8 x maxStale
  const hbIntervalS = Number(hbAge) * slotMs / 1000;
  const pushesPerHour = 3600 / hbIntervalS;
  const lamportsPerPush = 5000;                                    // oracle pays its own 1-sig fee
  const solPerDay = pushesPerHour * 24 * lamportsPerPush / 1e9;
  const outageToStaleS = Number(maxStale) * slotMs / 1000;         // age > maxStale -> oracleStale + permissionless wind-down
  const outageToAlarmS = Number(alarm) * slotMs / 1000;
  return { hbAge, alarm, hbIntervalS, pushesPerHour, solPerDay, outageToStaleS, outageToAlarmS };
}

async function main() {
  await assertDevnet(conn);
  say(`ROUND-5 maxStaleness rehearsal — percolator ${P.toBase58()}`);
  const slotMs = await measureSlotMs();
  say(`measured devnet slot time: ${slotMs.toFixed(1)} ms/slot (mainnet assumed ${MAINNET_SLOT_MS} ms/slot)`);

  say("\nAnalytic table (per candidate maxStaleness):");
  say("  maxStale | heartbeat@ | 0.8 alarm@ | hb interval | pushes/h | SOL/day (1-sig) | outage survival (to oracleStale) ");
  for (const ms of CCANDIDATES) {
    for (const [label, sm] of [["devnet", slotMs], ["mainnet", MAINNET_SLOT_MS]] as const) {
      const a = analytic(ms, sm);
      say(`  ${String(ms).padStart(8)} | ${String(a.hbAge).padStart(9)}s? | ${String(a.alarm).padStart(9)} | ${a.hbIntervalS.toFixed(1).padStart(7)}s | ${a.pushesPerHour.toFixed(1).padStart(7)} | ${a.solPerDay.toFixed(5).padStart(10)} | ${a.outageToStaleS.toFixed(0).padStart(5)}s (${label})`);
    }
  }

  // ---- empirical at maxStaleness = 150 (fastest): outage -> oracleStale timing + permissionless wind-down
  const MS = 150n;
  say(`\nEmpirical check at maxStaleness=${MS} (devnet):`);
  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const feeVault = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  const fTok = await createAccount(conn, funder, mint, funder.publicKey, Keypair.generate());
  await mintTo(conn, funder, mint, fTok, funder, 10_000n * POS_SCALE);
  const dex = await newAcc(P, DEX_SIZE);
  await send([initDex(P, { dex, admin: funder.publicKey, mint, feeVault, decimals: 6, createFee: 0n })]);
  const V: VaultAccounts = { dex, mint, vault: deriveDexVault(P, dex)[0] };
  const oracle = Keypair.generate();
  const fundingCfg = packFundingCfg({ baseIntE6: 100, deadbandE6: 500, maxFund8hBps: 100, decaySlots: 1440 });
  const params: MarketParams = { initPrice: e6(60_000), exitWindow: 10n, maxStaleness: MS, fundingCfg, imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n, maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n * POS_SCALE, minMm: 0n };
  const mkt = await newAcc(P, MARKET_SIZE);
  await send([createMarket(P, { dex, market: mkt, mint, oracleAuth: oracle.publicKey, creator: funder.publicKey, creatorToken: fTok, feeVault, params })]);
  const oL = Keypair.generate(), oS = Keypair.generate();
  const pL = await newAcc(P, PORTFOLIO_SIZE), pS = await newAcc(P, PORTFOLIO_SIZE);
  await send([initPortfolio(P, { dex, portfolio: pL, owner: oL.publicKey })], [oL]);
  await send([initPortfolio(P, { dex, portfolio: pS, owner: oS.publicKey })], [oS]);
  await send([depositCollateral(P, V, { portfolio: pL, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([depositCollateral(P, V, { portfolio: pS, depositor: funder.publicKey, sourceToken: fTok, amount: 100n * POS_SCALE })]);
  await send([trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 1_000n })], [oL, oS]);
  // measure a real heartbeat push cost (oracle pays its own 1-sig fee)
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: oracle.publicKey, lamports: 5_000_000 })]);
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(uniq(), updateOracle(P, { market: mkt, oracleAuth: oracle.publicKey, price: e6(60_000) })), [oracle], { commitment: "confirmed" });
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  say(`  real oracle-paid heartbeat push fee: ${tx?.meta?.fee} lamports (1 signature), compute ${tx?.meta?.computeUnitsConsumed} CU`);

  // outage: stop pushing, time until a Trade reverts oracleStale (106)
  const start = Date.now(); const startSlot = await conn.getSlot("confirmed");
  let staleAtMs = 0, staleAtSlot = 0n;
  const tradeIx = () => [refreshLeg(P, { dex, market: mkt, portfolio: pL }), refreshLeg(P, { dex, market: mkt, portfolio: pS }), trade(P, { dex, market: mkt, longPortfolio: pL, longOwner: oL.publicKey, shortPortfolio: pS, shortOwner: oS.publicKey, mode: TRADE_MODE.OPEN, qty: 100n })];
  for (let i = 0; i < 120; i++) {
    const tx2 = new Transaction().add(...tradeIx()); tx2.feePayer = funder.publicKey; tx2.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx2.sign(funder, oL, oS);
    const r = (await conn.simulateTransaction(tx2)).value;
    const code = (r.err as any)?.InstructionError?.[1]?.Custom;
    if (code === 106) { staleAtMs = Date.now() - start; staleAtSlot = BigInt(await conn.getSlot("confirmed")) - BigInt(startSlot); break; }
    await sleep(2000);
  }
  say(`  outage survival: Trade reverted oracleStale(106) after ${(staleAtMs / 1000).toFixed(0)}s (~${staleAtSlot} slots) with no oracle push`);

  // permissionless wind-down: any attacker can StartWindDown once stale
  const atk = Keypair.generate();
  const t1 = new Transaction().add(startWindDown(P, { market: mkt, caller: atk.publicKey })); t1.feePayer = funder.publicKey; t1.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; t1.sign(funder, atk);
  const wd = (await conn.simulateTransaction(t1)).value;
  const wdCode = (wd.err as any)?.InstructionError?.[1]?.Custom;
  say(`  permissionless StartWindDown by a stranger once stale: ${wd.err ? `rejected (${wdCode})` : "ALLOWED (irreversible griefing kill)"}`);

  say(`\nRECOMMENDATION:`);
  const rec300 = analytic(300n, MAINNET_SLOT_MS);
  say(`  - maxStaleness = 300 slots (~${(300 * MAINNET_SLOT_MS / 1000).toFixed(0)}s mainnet outage survival) balances freshness vs keeper-outage risk:`);
  say(`    heartbeat every ~${rec300.hbIntervalS.toFixed(0)}s (${rec300.pushesPerHour.toFixed(1)} pushes/h, ~${rec300.solPerDay.toFixed(4)} SOL/day at 1-sig).`);
  say(`  - 150 is too tight: a ~${(150 * MAINNET_SLOT_MS / 1000).toFixed(0)}s keeper hiccup lets ANY attacker permissionlessly + IRREVERSIBLY StartWindDown.`);
  say(`  - 900 is safer against outages (~${(900 * MAINNET_SLOT_MS / 1000).toFixed(0)}s) but lets the mark drift further between pushes (worse latency-arb vs the vault).`);
  say(`  - Because wind-down is irreversible, run a SECOND independent keeper instance (different fee payer) so a single keeper outage cannot cross maxStaleness.`);
  process.exit(0);
}
main().catch((e) => { console.error(maskSecrets(String(e)).slice(0, 800)); process.exit(1); });
