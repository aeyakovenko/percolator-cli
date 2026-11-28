/** Refresh the counterparty short's leg (permissionless RefreshLeg) so both sides of the prize pair are realized. */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { refreshLeg } from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync("lean-mainnet-r4.json", "utf8"));
const f = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
(async () => {
  const s = await sendAndConfirmTransaction(conn, new Transaction().add(refreshLeg(new PublicKey(m.percolator), { dex: new PublicKey(m.dex), market: new PublicKey(m.market), portfolio: new PublicKey(m.counterpartyShort) })), [f], { commitment: "confirmed" });
  console.log("refreshed counterparty short", s.slice(0, 12));
})().catch(e => { console.error("ERR", String(e).slice(0, 300)); process.exit(1); });
