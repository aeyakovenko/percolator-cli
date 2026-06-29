import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encUpdateAuthority, marketAccountLenFor,
  HEADER_LEN, WRAPPER_CONFIG_OFF, WC,
} from "../src/v16/index.js";

const HOME = process.env.HOME!;
const RPC = `https://devnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const PROG = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));

const cu = (units = 1_400_000) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

(async () => {
  const market = Keypair.generate();
  const newAuth = Keypair.generate();

  // Allocate market
  const len = marketAccountLenFor(1);
  const rent = await conn.getMinimumBalanceForRentExemption(len);
  await sendAndConfirmTransaction(conn, new Transaction().add(...cu(),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey, lamports: rent, space: len, programId: PROG }),
  ), [admin, market], { commitment: "confirmed", skipPreflight: true });

  // InitMarket
  await sendAndConfirmTransaction(conn, new Transaction().add(...cu(), new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    ],
    data: encInitMarket({
      maxPortfolioAssets: 1, hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
      minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
      maintenanceMarginBps: 500n, initialMarginBps: 500n,
      maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
      liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
      minLiquidationAbs: 0n,
      maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n,
      maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
      maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
      maxBankruptCloseLifetimeSlots: 10_000_000n,
      publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 35n,
    } as any),
  })), [admin], { commitment: "confirmed", skipPreflight: true });

  // Fund newAuth so it can sign
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: newAuth.publicKey, lamports: 1_000_000 }),
  ), [admin], { commitment: "confirmed" });

  // Read initial marketauth
  const d0 = (await conn.getAccountInfo(market.publicKey, "confirmed"))!.data;
  const ma0 = new PublicKey(d0.slice(HEADER_LEN + WC.marketauth, HEADER_LEN + WC.marketauth + 32));
  console.log(`pre-rotate  marketauth = ${ma0.toBase58()}  (admin = ${admin.publicKey.toBase58()})`);
  console.log(`newAuth     = ${newAuth.publicKey.toBase58()}`);

  // Rotate admin → newAuth
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...cu(), new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: newAuth.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ],
    data: encUpdateAuthority({ newPubkey: newAuth.publicKey }),
  })), [admin, newAuth], { commitment: "confirmed", skipPreflight: true });
  console.log(`rotate sig: ${sig}`);

  // Read post-rotate marketauth with several commitment levels
  for (const c of ["processed", "confirmed", "finalized"] as const) {
    const d = (await conn.getAccountInfo(market.publicKey, c))!.data;
    const ma = new PublicKey(d.slice(HEADER_LEN + WC.marketauth, HEADER_LEN + WC.marketauth + 32));
    console.log(`post-rotate [${c.padEnd(10)}] marketauth = ${ma.toBase58()}`);
  }

  // Read raw bytes
  const d2 = (await conn.getAccountInfo(market.publicKey, "confirmed"))!.data;
  console.log(`raw data[16..48]: ${Array.from(d2.slice(16, 48)).map(b => b.toString(16).padStart(2,'0')).join('')}`);

  // Teardown
  // (skipped — leave market for inspection)
  console.log(`market: ${market.publicKey.toBase58()}`);
})();
