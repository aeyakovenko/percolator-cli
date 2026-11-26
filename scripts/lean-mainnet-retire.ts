/** Retire the drained mainnet bounty market: wind down -> resolve -> tombstone -> close (reclaim rent). */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { LEAN_MAINNET, startWindDown, resolveMarket, tombstoneMarket, closeAccount, parseMarket } from "../src/lean/index.js";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_MAINNET.percolator;
const DEX = new PublicKey("6nxbqVQREBwW2ESc1sJyPaUH9yZ7MgKE53fQh3Fm1CkH");
const MKT = new PublicKey("76oGDQbQW3MEteg2uQqf31PyTmFZp8ujZTyGu3kfFSwq");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
async function send(ix: TransactionInstruction) { for (let i = 0; ; i++) { try { return await sendAndConfirmTransaction(conn, new Transaction().add(ix), [funder], { commitment: "confirmed" }); } catch (e) { const m = String((e as Error).message ?? e); if (i < 6 && /429|Too Many|block height|timed out/i.test(m)) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; } throw e; } } }
const st = async () => parseMarket(Buffer.from((await conn.getAccountInfo(MKT))!.data));

async function main() {
  let m = await st();
  console.log(`market status=${m.statusName} oi=${m.oiLong}/${m.oiShort} insurance=${Number(m.insurance) / 1e6} admin=${m.marketAdmin?.toBase58() ?? "burned"}`);
  const sol0 = await conn.getBalance(funder.publicKey);
  try {
    if (m.statusName === "Active") { await send(startWindDown(P, { market: MKT, caller: funder.publicKey })); console.log("-> WindDown"); }
    m = await st();
    if (m.statusName === "WindDown") { await send(resolveMarket(P, { dex: DEX, market: MKT })); console.log("-> Resolved"); }
    m = await st();
    if (m.statusName === "Resolved") { await send(tombstoneMarket(P, { market: MKT })); console.log("-> Tombstoned"); }
    m = await st();
    if (m.statusName === "Tombstoned") {
      await send(closeAccount(P, { account: MKT, authority: funder.publicKey, destination: new PublicKey("11111111111111111111111111111112") }));
      console.log("-> market account closed, rent reclaimed");
    }
  } catch (e) { console.log("step failed (stopping):", String(e).slice(0, 160)); }
  const after = await conn.getAccountInfo(MKT);
  console.log(`\nfinal: market ${after ? "still exists (status " + (await st()).statusName + ")" : "CLOSED"} — reclaimed ${((await conn.getBalance(funder.publicKey) - sol0) / 1e9).toFixed(5)} SOL net`);
  console.log("note: DEX account + vault token account rent (~0.004 SOL) and the two InsReceipts are not closeable (no DEX-close ix / totalInsShares underflow) — dust left behind.");
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
