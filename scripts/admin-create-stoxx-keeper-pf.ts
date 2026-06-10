import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import { encInitPortfolio, PORTFOLIO_ACCOUNT_LEN } from "../src/v16/index.js";

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
  const PROG = new PublicKey(M.programId);
  const MARKET = new PublicKey(M.market);
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const KEEPER = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/bounty5-keeper.json`, "utf8"))));

  // Stable derivation: new keeper portfolio = fresh keypair, saved to disk
  const KP_PATH = `${process.env.HOME}/.config/solana/stoxx-sol-keeper-pf.json`;
  let pfKp: Keypair;
  if (fs.existsSync(KP_PATH)) {
    pfKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KP_PATH, "utf8"))));
    console.log("re-using saved kp:", pfKp.publicKey.toBase58());
  } else {
    pfKp = Keypair.generate();
    fs.writeFileSync(KP_PATH, JSON.stringify(Array.from(pfKp.secretKey)));
    fs.chmodSync(KP_PATH, 0o600);
    console.log("generated new kp:", pfKp.publicKey.toBase58(), "→", KP_PATH);
  }

  const ai = await conn.getAccountInfo(pfKp.publicKey, "confirmed");
  if (ai && ai.data.length > 0) {
    console.log("account already exists, skipping create");
  } else {
    const rent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
    console.log("creating account at", PORTFOLIO_ACCOUNT_LEN, "B, rent =", rent, "lamports");
    const createTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: pfKp.publicKey,
        lamports: rent,
        space: PORTFOLIO_ACCOUNT_LEN,
        programId: PROG,
      }),
    );
    const sigCreate = await sendAndConfirmTransaction(conn, createTx, [admin, pfKp], { skipPreflight: true });
    console.log("create OK:", sigCreate);
  }

  // InitPortfolio — accounts: [admin/owner (signer), market, portfolio]
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
    const sig = await sendAndConfirmTransaction(conn, initTx, [KEEPER], { skipPreflight: true });
    console.log("init OK:", sig);
    console.log("\nNEW KEEPER PORTFOLIO:", pfKp.publicKey.toBase58());
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.log("init err:", msg.slice(0, 300));
    const sigm = msg.match(/Transaction (\w{32,})/);
    if (sigm) {
      await new Promise(r => setTimeout(r, 2500));
      const t = await conn.getTransaction(sigm[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("---logs---");
      console.log((t?.meta?.logMessages ?? []).slice(-12).join("\n"));
    }
  }
})();
