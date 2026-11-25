/**
 * Read-only survey of every percolator-lean DEX on a cluster: discovers all DEXes,
 * markets and portfolios under the program, parses them, and checks the conservation
 * invariants per DEX (checkDexInvariants). No signing.
 *
 *   pnpm lean:survey                      # devnet program GD43…
 *   LEAN_PROG=<id> SOLANA_RPC_URL=… pnpm lean:survey
 *
 * Exit code 1 if any DEX violates an invariant.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  LEAN_DEVNET, POS_SCALE, discoverDexes, discoverMarkets, discoverPortfolios, checkDexInvariants,
} from "../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROG = new PublicKey(process.env.LEAN_PROG ?? LEAN_DEVNET.percolator.toBase58());
const conn = new Connection(RPC, "confirmed");
const usd = (v: bigint) => (Number(v) / Number(POS_SCALE)).toFixed(2);

async function main() {
  const [dexes, markets, portfolios] = await Promise.all([
    discoverDexes(conn, PROG), discoverMarkets(conn, PROG), discoverPortfolios(conn, PROG),
  ]);
  console.log(`program ${PROG.toBase58()}: ${dexes.length} dexes, ${markets.length} markets, ${portfolios.length} portfolios`);
  let bad = 0;
  for (const d of dexes) {
    const ms = markets.filter((m) => m.data.dex.equals(d.address));
    const ps = portfolios.filter((p) => p.data.dex.equals(d.address));
    const bal = BigInt((await conn.getTokenAccountBalance(d.data.vault, "confirmed")).value.amount);
    const rep = checkDexInvariants(d.data, bal, ms.map((m) => m.data), ps.map((p) => p.data));
    const status = ms.reduce((acc, m) => { acc[m.data.statusName] = (acc[m.data.statusName] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const openLegs = ps.reduce((a, p) => a + p.data.legs.filter((l) => l.side !== 0).length, 0);
    console.log(
      `${rep.ok ? "OK  " : "FAIL"} dex ${d.address.toBase58()} V=${usd(d.data.vaultBalance)} C=${usd(d.data.totalCapital)} ` +
      `I=${usd(d.data.totalInsurance)} R=${usd(d.data.totalResidual)} | markets ${JSON.stringify(status)} | ` +
      `portfolios ${ps.length} (${openLegs} open legs)`,
    );
    if (!rep.ok) { bad++; for (const p of rep.problems) console.log(`       - ${p}`); }
  }
  if (bad) { console.log(`${bad} dex(es) violate invariants`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
