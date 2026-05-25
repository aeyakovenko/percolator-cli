/**
 * Targeted probe: deposit 100M, open ONE small trade, read capital and adjacent
 * fields after each step. Goal: figure out where deposited capital migrates to
 * once a position is opened.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encTradeNoCpi, encConfigureHyperpMark,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, PA, PORTFOLIO_STATE_OFF,
} from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

const cu = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}

async function dump(label: string, port: PublicKey, mkt: PublicKey) {
  const p = await conn.getAccountInfo(port, "confirmed");
  const m = await conn.getAccountInfo(mkt,  "confirmed");
  const rd128 = (d: Buffer, off: number) =>
    d.readBigUInt64LE(off) | (d.readBigUInt64LE(off + 8) << 64n);
  const rdi128 = (d: Buffer, off: number) => {
    const v = rd128(d, off);
    return v >= (1n << 127n) ? v - (1n << 128n) : v;
  };
  if (!p || !m) { console.log(`${label}: missing accounts`); return; }
  const Po = PORTFOLIO_STATE_OFF;
  const Mo = MARKET_GROUP_OFF;
  console.log(`\n--- ${label} ---`);
  console.log(`  portfolio:`);
  console.log(`    capital      @${Po + PA.capital}        = ${rd128(p.data, Po + PA.capital)}`);
  console.log(`    pnl          @${Po + PA.pnl}            = ${rdi128(p.data, Po + PA.pnl)}`);
  console.log(`    reserved_pnl @${Po + PA.reserved_pnl}   = ${rd128(p.data, Po + PA.reserved_pnl)}`);
  console.log(`    fee_credits  @${Po + PA.fee_credits}    = ${rdi128(p.data, Po + PA.fee_credits)}`);
  console.log(`    cancel_dep_esc @${Po + PA.cancel_deposit_escrow} = ${rd128(p.data, Po + PA.cancel_deposit_escrow)}`);
  console.log(`    last_fee_slot @${Po + PA.last_fee_slot} = ${p.data.readBigUInt64LE(Po + PA.last_fee_slot)}`);
  console.log(`    active_bitmap @${Po + PA.active_bitmap} = 0x${p.data.readBigUInt64LE(Po + PA.active_bitmap).toString(16)}`);
  console.log(`  market group:`);
  console.log(`    vault     @${Mo + MG.vault}     = ${rd128(m.data, Mo + MG.vault)}`);
  console.log(`    c_tot     @${Mo + MG.c_tot}     = ${rd128(m.data, Mo + MG.c_tot)}`);
  console.log(`    insurance @${Mo + MG.insurance} = ${rd128(m.data, Mo + MG.insurance)}`);
  console.log(`    pnl_pos_tot @${Mo + MG.pnl_pos_tot} = ${rd128(m.data, Mo + MG.pnl_pos_tot)}`);
  console.log(`    slot_last @${Mo + MG.slot_last} = ${m.data.readBigUInt64LE(Mo + MG.slot_last)}`);
  console.log(`    current_slot @${Mo + MG.current_slot} = ${m.data.readBigUInt64LE(Mo + MG.current_slot)}`);
}

async function main() {
  const market = Keypair.generate();
  const port = Keypair.generate();
  const portB = Keypair.generate();           // counterparty
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);

  console.log("market:", market.publicKey.toBase58());
  console.log("port:  ", port.publicKey.toBase58());
  console.log("portB: ", portB.publicKey.toBase58());

  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);

  // [1] create + InitMarket + InitPortfolio
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...cu(60_000))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: port.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
    .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
    [admin, market, port, portB], { commitment: "confirmed" });

  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...cu(600_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      ],
      data: encInitMarket({
        maxPortfolioAssets: 1,
        hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
        minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
        maintenanceMarginBps: 500n, initialMarginBps: 500n,
        maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
        liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
        minLiquidationAbs: 0n,
        maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n,
        maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
        maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
        publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 58n,
      }),
    })), [admin], { commitment: "confirmed" });

  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...cu(400_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
      ],
      data: encConfigureHyperpMark({
        assetIndex: 0, nowSlot: BigInt(await conn.getSlot("confirmed")),
        initialMarkE6: 1_000_000n, markEwmaHalflifeSlots: 300n, markMinFee: 500n,
      }),
    })), [admin], { commitment: "confirmed" });

  for (const p of [port, portB]) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...cu(400_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
        ], data: encInitPortfolio(),
      })), [admin], { commitment: "confirmed" });
  }

  await dump("after InitPortfolio (pre-deposit)", port.publicKey, market.publicKey);

  // [2] wrap SOL + create vault ATA + Deposit
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...cu(50_000))
    .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
    .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: 200_000_000 }))
    .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
           programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }),
    [admin], { commitment: "confirmed" });

  for (const p of [port, portB]) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(...cu(600_000))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: p.publicKey, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encDeposit(100_000_000n),
      })), [admin], { commitment: "confirmed" });
  }

  await dump("after Deposit(100M) on both", port.publicKey, market.publicKey);

  // [3] Open ONE small two-party trade. TradeNoCpi takes 5 keys:
  //   [ownerA(signer), ownerB(signer), market, portA, portB]
  // Both portfolios are owned by `admin` here.
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(...cu(600_000))
    .add(new TransactionInstruction({
      programId: PROGRAM_ID, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: port.publicKey,   isSigner: false, isWritable: true },
        { pubkey: portB.publicKey,  isSigner: false, isWritable: true },
      ],
      data: encTradeNoCpi({ assetIndex: 0, sizeQ: 1_000_000n, execPrice: 1_000_000n, feeBps: 1n }),
    })), [admin], { commitment: "confirmed" });

  await dump("after TradeOpen A +1M / B -1M @ 1.0", port.publicKey, market.publicKey);
  await dump("counterparty B", portB.publicKey, market.publicKey);
}
main().catch(e => { console.error(e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
