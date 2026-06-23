/**
 * Close the existing mainnet STOXX/SOL keeper portfolio (BpFmbw74…).
 *
 * Must be run BEFORE upgrading 4m3ip to a wrapper that grew PortfolioAccount
 * beyond the old PA size — the new wrapper can't parse the old 9347-byte
 * portfolio bytes, so this is a one-way close while the OLD wrapper is still
 * live on mainnet.
 *
 * The keeper key signs (it owns the portfolio); rent (~0.066 SOL) is folded
 * into the market slab via close_portfolio_account_to_market_slab — not paid
 * back to the keeper or admin directly.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import { encClosePortfolio } from "../src/v16/index.js";

(async () => {
  const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(RPC, "confirmed");
  const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
  const PROG = new PublicKey(M.programId);
  const MARKET = new PublicKey(M.market);
  const PF = new PublicKey(M.keeperPortfolio);
  const KEEPER = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/bounty5-keeper.json`, "utf8"))));

  const ai = await conn.getAccountInfo(PF, "confirmed");
  if (!ai) {
    console.log("portfolio already gone:", PF.toBase58());
    return;
  }
  console.log("closing portfolio", PF.toBase58(), `(${ai.data.length} B, ${ai.lamports / 1e9} SOL rent)`);

  const ix = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: KEEPER.publicKey, isSigner: true, isWritable: false },   // closer/owner
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: PF, isSigner: false, isWritable: true },
    ],
    data: encClosePortfolio(),
  });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ix,
  );
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [KEEPER], { commitment: "confirmed", skipPreflight: true });
    console.log("close OK:", sig);
  } catch (e: any) {
    console.log("close err:", String(e?.message ?? e).slice(0, 400));
    const sigm = String(e?.message ?? e).match(/Transaction (\w{32,})/);
    if (sigm) {
      await new Promise(r => setTimeout(r, 2500));
      const t = await conn.getTransaction(sigm[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("logs:", (t?.meta?.logMessages ?? []).slice(-12).join("\n"));
    }
  }

  const after = await conn.getAccountInfo(PF, "confirmed");
  console.log(after ? `still exists (${after.lamports / 1e9} SOL)` : "portfolio GONE — safe to deploy new wrapper");

  // Move the stale portfolio keypair file aside so the next create script
  // generates a fresh keypair at the new PORTFOLIO_ACCOUNT_LEN.
  const KP_PATH = `${process.env.HOME}/.config/solana/stoxx-sol-keeper-pf.json`;
  if (fs.existsSync(KP_PATH) && !after) {
    const stash = `${KP_PATH}.preupgrade-${Date.now()}`;
    fs.renameSync(KP_PATH, stash);
    console.log("moved stale keypair file to", stash);
  }
})();
