/** DEVNET in-place upgrade proof, percolator-lean 55c167f (Issue #117) insurance cases on the mirrored state.
 *    npx -y tsx scripts/_lean-upgrade-ins117.ts pre     # BEFORE the upgrade (887ba02): a pre-existing receipt on the sacrificial MKT3
 *    npx -y tsx scripts/_lean-upgrade-ins117.ts after   # AFTER the upgrade: WithdrawInsurance with open interest
 *    npx -y tsx scripts/_lean-upgrade-ins117.ts empty   # at the very end (MKT3 empty): deposit + IMMEDIATE withdraw
 *  55c167f: InsReceipt bytes 4..7 = lastDepositBucket (slot >> 4), stamped by share-minting deposits; WithdrawInsurance
 *  with OI > 0 is allowed iff insFronted == 0 && adlLong == adlShort == ADL_ONE && curBucket - lastDepositBucket >= 10. */
import { PublicKey } from "@solana/web3.js";
import {
  INS_RECEIPT_SIZE, POS_SCALE, ADL_ONE, depositInsurance, withdrawInsurance, closeAccount, parseInsReceipt, insWithdrawReadyAt, deriveDexVault,
  type VaultAccounts,
} from "../src/lean/index.js";
import { conn, funder, guard, send, sim, newAcc, loadMani, saveMani, snapshot, sleep, U, mkt, acct, ok, fails, pass, mask, tokBal } from "./_lean-upgrade-lib.js";

const STAGE = process.argv[2] ?? "";
const m = loadMani();
const P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MKT1 = new PublicKey(m.market), MKT3 = new PublicKey(m.extra.market3);
const MINT = new PublicKey(m.usdc), FTOK = new PublicKey(m.funderToken), O = funder.publicKey;
const V: VaultAccounts = { dex: DEX, mint: MINT, vault: deriveDexVault(P, DEX)[0] };
const RC = new PublicKey(m.insReceipt);
const wd = (market: PublicKey, receipt: PublicKey, burnShares: bigint) => withdrawInsurance(P, V, { market, receipt, lp: O, destToken: FTOK, burnShares });
async function conservation(label: string) {
  const s = await snapshot(P, DEX, V.vault);
  ok(s.conserved && s.inv.ok, `${label}: conservation @slot ${s.slot} V=$${U(s.dex.vaultBalance)} I=$${U(s.dex.totalInsurance)} ${s.inv.problems.join("; ")}`);
}

async function pre() {
  const rc3 = await newAcc(INS_RECEIPT_SIZE, P);
  await send([depositInsurance(P, V, { market: MKT3, receipt: rc3, lp: O, sourceToken: FTOK, amount: 4n * POS_SCALE })]);
  m.extra.insReceipt3pre = rc3.toBase58(); saveMani(m);
  for (const [n, k] of [["MKT1 prize receipt", RC], ["MKT3 receipt", rc3]] as const) {
    const b = await acct(k);
    ok(b.readUInt32LE(4) === 0 && parseInsReceipt(b).shares > 0n, `${n} deposited under 887ba02: bytes 4..7 = ${b.readUInt32LE(4)}, shares ${parseInsReceipt(b).shares}`);
  }
  const r = await sim([wd(MKT1, RC, 1n)]);
  ok(r.code === 118, `887ba02: WithdrawInsurance with OI > 0 -> ${r.name}`);
  await conservation("ins117 pre");
}

async function after() {
  const a = await mkt(MKT1);
  ok(a.oiLong > 0n && a.insFronted === 0n && a.adlLong === ADL_ONE && a.adlShort === ADL_ONE, `MKT1 has open interest ${a.oiLong}/${a.oiShort}, insFronted 0, ADL = 1 (healthy)`);
  // (a) PRE-EXISTING receipt (bytes 4..7 = 0 from 887ba02) can now leave while OI > 0
  const r0 = parseInsReceipt(await acct(RC));
  ok(r0.lastDepositBucket === 0 && insWithdrawReadyAt(r0, await conn.getSlot("confirmed")).ready, `pre-upgrade receipt: lastDepositBucket ${r0.lastDepositBucket} -> insWithdrawReadyAt().ready`);
  const full = await sim([wd(MKT1, RC, r0.shares)]);
  ok(full.ok, `pre-upgrade receipt: FULL withdraw (${r0.shares} shares) with OI > 0 simulates ${full.name} [${full.cu} CU]`);
  let b0 = await tokBal(FTOK);
  await send([wd(MKT1, RC, POS_SCALE)]);
  ok((await tokBal(FTOK)) - b0 === POS_SCALE && parseInsReceipt(await acct(RC)).shares === r0.shares - POS_SCALE, "pre-upgrade receipt: really withdrew $1.000000 (1e6 shares) while OI > 0");
  await conservation("after pre-existing receipt partial withdraw");
  // (b) FRESH deposit: stamped, immediate withdraw rejected, allowed after the 160-slot cooldown
  const rc = await newAcc(INS_RECEIPT_SIZE, P);
  const sig = await send([depositInsurance(P, V, { market: MKT1, receipt: rc, lp: O, sourceToken: FTOK, amount: 2n * POS_SCALE })]);
  const depSlot = (await conn.getSignatureStatus(sig)).value!.slot;
  const r1 = parseInsReceipt(await acct(rc));
  ok(r1.lastDepositBucket === depSlot >> 4, `fresh deposit stamped lastDepositBucket ${r1.lastDepositBucket} == depositSlot ${depSlot} >> 4`);
  const imm = await sim([wd(MKT1, rc, r1.shares)]);
  const cur0 = await conn.getSlot("confirmed");
  ok(imm.code === 118 && !insWithdrawReadyAt(r1, cur0).ready, `fresh deposit: immediate withdraw with OI > 0 -> ${imm.name}; client helper: ready=false, ${insWithdrawReadyAt(r1, cur0).slotsLeft} slots left`);
  const ready = insWithdrawReadyAt(r1, cur0).readySlot;
  let early: string | null = null;
  for (;;) {
    const cur = BigInt(await conn.getSlot("confirmed"));
    if (cur >= ready + 2n) break;
    if (cur < ready - 20n && cur > BigInt(depSlot) + 60n && early === null) early = (await sim([wd(MKT1, rc, r1.shares)])).name;
    await sleep(2000);
  }
  ok(early === null || /118/.test(early), `fresh deposit: still rejected mid-cooldown (${early ?? "not sampled"})`);
  const late = await sim([wd(MKT1, rc, r1.shares)]);
  ok(late.ok && insWithdrawReadyAt(r1, await conn.getSlot("confirmed")).ready, `fresh deposit: after readySlot ${ready} (deposit + ${ready - BigInt(depSlot)} slots) the withdraw with OI > 0 simulates ${late.name}`);
  b0 = await tokBal(FTOK);
  await send([wd(MKT1, rc, r1.shares)]);
  ok((await tokBal(FTOK)) - b0 === 2n * POS_SCALE, "fresh deposit: withdrew the full $2.000000 with OI > 0 after the cooldown");
  await send([closeAccount(P, { account: rc, authority: O, destination: O })]);
  // (c) topping up the pre-existing receipt re-arms the cooldown for the WHOLE receipt
  await send([depositInsurance(P, V, { market: MKT1, receipt: RC, lp: O, sourceToken: FTOK, amount: POS_SCALE })]);
  const r2 = parseInsReceipt(await acct(RC));
  const top = await sim([wd(MKT1, RC, 1n)]);
  ok(r2.lastDepositBucket > 0 && top.code === 118, `top-up of the pre-upgrade receipt stamps it (bucket ${r2.lastDepositBucket}) and re-arms the cooldown for all its shares -> ${top.name}`);
  // (d) a donation does not mint shares and does not stamp
  await send([depositInsurance(P, V, { market: MKT1, receipt: RC, lp: O, sourceToken: FTOK, amount: 10_000n, donate: true })]);
  ok(parseInsReceipt(await acct(RC)).lastDepositBucket === r2.lastDepositBucket, "a donation does not change lastDepositBucket");
  const a2 = await mkt(MKT1);
  console.log(`    MKT1 insurance now $${U(a2.insurance)} (shares ${a2.totalInsShares})`);
  await conservation("ins117 after");
}

async function empty() {
  const a = await mkt(MKT3);
  ok(a.oiLong === 0n && a.rawBasisLong === 0n && a.rawBasisShort === 0n, "MKT3 is empty");
  const rc = await newAcc(INS_RECEIPT_SIZE, P);
  await send([depositInsurance(P, V, { market: MKT3, receipt: rc, lp: O, sourceToken: FTOK, amount: 2n * POS_SCALE })]);
  const r = parseInsReceipt(await acct(rc)); const b0 = await tokBal(FTOK);
  const cur = await conn.getSlot("confirmed");
  await send([wd(MKT3, rc, r.shares)]);
  ok((await tokBal(FTOK)) - b0 > 0n && !insWithdrawReadyAt(r, cur).ready, `EMPTY market: deposit then IMMEDIATE withdraw works (got $${U((await tokBal(FTOK)) - b0)}) although the cooldown had ${insWithdrawReadyAt(r, cur).slotsLeft} slots left`);
  await send([closeAccount(P, { account: rc, authority: O, destination: O })]);
  await conservation("ins117 empty");
}

(async () => {
  await guard();
  console.log(`=== ins117 ${STAGE} on ${P.toBase58()} ===`);
  if (STAGE === "pre") await pre(); else if (STAGE === "after") await after(); else if (STAGE === "empty") await empty(); else throw new Error("stage: pre | after | empty");
  console.log(`\nINS117 ${STAGE}: ${pass} ok, ${fails.length} failed`);
  if (fails.length) { console.log("FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("ERR", mask(String((e as Error).stack ?? e)).slice(0, 1200)); process.exit(1); });
