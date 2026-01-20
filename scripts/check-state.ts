import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);

  console.log("Current State:");
  console.log("Vault:", (vaultInfo?.lamports || 0) / 1e9, "SOL");
  console.log("My pubkey:", payer.publicKey.toBase58());

  console.log("\nAccounts:");
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      const isMyAccount = acc.owner?.equals(payer.publicKey);
      console.log("[" + idx + "]", kind + ":", "owner=" + acc.owner?.toBase58().slice(0, 16) + "...", "capital=" + (Number(acc.capital) / 1e9).toFixed(6), "pos=" + acc.positionSize, isMyAccount ? "<-- MINE" : "");
    }
  }

  // Check solvency
  const engine = parseEngine(data);
  let totalLiabilities = engine.insuranceFund.balance;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      totalLiabilities += acc.capital;
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      totalLiabilities += pnl;
    }
  }
  console.log("\nLiabilities:", (Number(totalLiabilities) / 1e9).toFixed(6), "SOL");
  console.log("Insurance:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(6), "SOL");
  console.log("Status:", (vaultInfo?.lamports || 0) / 1e9 >= Number(totalLiabilities) / 1e9 ? "SOLVENT" : "*** INSOLVENT ***");
}

main().catch(console.error);
