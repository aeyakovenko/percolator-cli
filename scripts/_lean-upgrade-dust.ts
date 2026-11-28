/** DEVNET upgrade proof helper: inspect / finish a wound-down market that still holds dust legs after ForceClosePair.
 *    npx -y tsx scripts/_lean-upgrade-dust.ts <market> [send]
 *  Simulates (and with `send` executes, one at a time, re-simulating after each) every permissionless exit:
 *  ForceClosePair, ClearDeadLeg(long/short), RefreshLeg(long/short), Liquidate(long/short), ResolveMarket. */
import { PublicKey } from "@solana/web3.js";
import { forceClosePair, clearDeadLeg, refreshLeg, liquidate, resolveMarket, deriveDexVault, withLegRefresh, type VaultAccounts } from "../src/lean/index.js";
import { conn, guard, send, sim, loadMani, mkt, pfl, acct, U, mask, CU, snapshot } from "./_lean-upgrade-lib.js";

const m = loadMani();
const P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MINT = new PublicKey(m.usdc), FTOK = new PublicKey(m.funderToken);
const V: VaultAccounts = { dex: DEX, mint: MINT, vault: deriveDexVault(P, DEX)[0] };
const MK = new PublicKey(process.argv[2]);
const SEND = process.argv.includes("send");
let L: PublicKey, S: PublicKey;
const show = async () => {
  const a = await mkt(MK); const raw = await acct(MK);
  console.log(`market ${a.statusName} mark $${U(a.markPrice)} oi ${a.oiLong}/${a.oiShort} raw ${a.rawBasisLong}/${a.rawBasisShort} adl ${a.adlLong}/${a.adlShort} R ${a.realizedPool} P+ ${a.totalPosPnl} ins ${a.insurance} deficit ${raw[5]} activeLegs ${a.activeLegs}`);
  for (const [n, k] of [["long ", L], ["short", S]] as const) { const p = await pfl(k); console.log(`  ${n}: capital ${p.capital} locked ${p.totalLockedMm} legs ${p.legs.map((l) => `${l.sideName} raw ${l.rawBasis} pnl ${l.posPnl} mm ${l.cachedMm} lockedMm ${l.lockedMm}`).join("; ")}`); }
};
(async () => {
  await guard();
  {
    // discover the (single) long and short portfolio still holding a leg on this market
    const snap = await snapshot(P, DEX, V.vault);
    for (const [k, p] of snap.portfolios) for (const l of p.legs) if (l.market.equals(MK) && l.rawBasis > 0n) { if (l.side === 1) L = new PublicKey(k); else S = new PublicKey(k); }
    if (!L! || !S!) throw new Error("no long/short dust legs found on this market");
    console.log(`long ${L!.toBase58()} short ${S!.toBase58()}`);
  }
  for (let round = 0; round < 6; round++) {
    await show();
    const cands: [string, any[]][] = [
      ["ForceClosePair", [forceClosePair(P, { dex: DEX, market: MK, longPortfolio: L, shortPortfolio: S })]],
      ["ClearDeadLeg(long)", [clearDeadLeg(P, { dex: DEX, market: MK, portfolio: L })]],
      ["ClearDeadLeg(short)", [clearDeadLeg(P, { dex: DEX, market: MK, portfolio: S })]],
      ["Liquidate(long)", (await withLegRefresh(conn, [liquidate(P, V, { market: MK, portfolio: L, liquidatorToken: FTOK })], { percolator: P })).instructions],
      ["Liquidate(short)", (await withLegRefresh(conn, [liquidate(P, V, { market: MK, portfolio: S, liquidatorToken: FTOK })], { percolator: P })).instructions],
      ["RefreshLeg(long)", [refreshLeg(P, { dex: DEX, market: MK, portfolio: L })]],
      ["RefreshLeg(short)", [refreshLeg(P, { dex: DEX, market: MK, portfolio: S })]],
      ["ResolveMarket", [resolveMarket(P, { dex: DEX, market: MK })]],
    ];
    let did = false;
    for (const [name, ixs] of cands) {
      const r = await sim(ixs);
      console.log(`  sim ${name.padEnd(20)} -> ${r.name}`);
      if (SEND && r.ok && !did && !/^RefreshLeg/.test(name)) { await send([CU(), ...ixs]); console.log(`  SENT ${name}`); did = true; }
    }
    if (!SEND || !did) break;
  }
  await show();
  process.exit(0);
})().catch((e) => { console.error("ERR", mask(String(e)).slice(0, 600)); process.exit(1); });
