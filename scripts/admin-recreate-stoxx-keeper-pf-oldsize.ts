/**
 * One-off: recreate the mainnet STOXX/SOL keeper portfolio AT THE OLD
 * PORTFOLIO_ACCOUNT_LEN (9347B) — matching the wrapper currently on mainnet
 * (8d1c82c, BPF 97c44071). We rolled back from fd98358 because the
 * b0e221a→91a46c0 engine bump added required V16Config fields that the
 * already-live market HgpvbLJh's MG header doesn't have, so try_to_runtime()
 * rejects the existing market with InvalidConfig.
 *
 * For the fd98358 migration to land, the market itself must be wound down
 * and re-launched (cannot just upgrade in place). Until then, the keeper PF
 * needs to exist at the 9347B layout so the keeper can run.
 *
 * Re-uses the same keypair (BpFmbw74…) that we closed earlier, restored
 * from the .preupgrade backup.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction, SystemProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import { encInitPortfolio } from "../src/v16/index.js";

const OLD_PORTFOLIO_ACCOUNT_LEN = 9347;

(async () => {
  const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(RPC, "confirmed");
  const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
  const PROG = new PublicKey(M.programId);
  const MARKET = new PublicKey(M.market);
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const KEEPER = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/bounty5-keeper.json`, "utf8"))));

  // Restore the original keypair from the .preupgrade backup so the
  // portfolio pubkey stays BpFmbw74… (matches mainnet-stoxx-sol-market.json).
  const KP_PATH = `${process.env.HOME}/.config/solana/stoxx-sol-keeper-pf.json`;
  if (!fs.existsSync(KP_PATH)) {
    const backups = fs.readdirSync(`${process.env.HOME}/.config/solana/`)
      .filter(f => f.startsWith("stoxx-sol-keeper-pf.json.preupgrade-"))
      .sort()
      .reverse();
    if (!backups.length) throw new Error("no keeper-pf keypair and no preupgrade backup");
    fs.copyFileSync(`${process.env.HOME}/.config/solana/${backups[0]}`, KP_PATH);
    fs.chmodSync(KP_PATH, 0o600);
    console.log("restored keypair from", backups[0]);
  }
  const pfKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KP_PATH, "utf8"))));
  console.log("keeper pf pubkey:", pfKp.publicKey.toBase58());

  const ai = await conn.getAccountInfo(pfKp.publicKey, "confirmed");
  if (ai && ai.data.length > 0) {
    console.log("account already exists — skipping create");
  } else {
    const rent = await conn.getMinimumBalanceForRentExemption(OLD_PORTFOLIO_ACCOUNT_LEN);
    console.log("creating at", OLD_PORTFOLIO_ACCOUNT_LEN, "B, rent =", rent, "lamports");
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: pfKp.publicKey,
        lamports: rent,
        space: OLD_PORTFOLIO_ACCOUNT_LEN,
        programId: PROG,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [admin, pfKp], { commitment: "confirmed", skipPreflight: true });
    console.log("create OK:", sig);
  }

  const initIx = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: KEEPER.publicKey, isSigner: true, isWritable: false },   // owner-to-be
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: pfKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: encInitPortfolio(),
  });
  const initTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    initIx,
  );
  try {
    const sig = await sendAndConfirmTransaction(conn, initTx, [KEEPER], { commitment: "confirmed", skipPreflight: true });
    console.log("init OK:", sig);
    console.log("keeper portfolio:", pfKp.publicKey.toBase58());
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.log("init err:", msg.slice(0, 400));
    const sigm = msg.match(/Transaction (\w{32,})/);
    if (sigm) {
      await new Promise(r => setTimeout(r, 2500));
      const t = await conn.getTransaction(sigm[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("logs:", (t?.meta?.logMessages ?? []).slice(-15).join("\n"));
    }
  }
})();
