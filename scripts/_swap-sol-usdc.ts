/** Swap SOL -> USDC for a target USD amount via Jupiter lite-api (quote-api is blocked here). */
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const targetUsd = Number(process.env.TARGET_USD ?? "22");
(async () => {
  const px: any = await (await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")).json();
  const solUsd = parseFloat(px.data.amount);
  const lamports = Math.ceil(targetUsd / solUsd * 1e9);
  console.log(`SOL=$${solUsd} -> swapping ${(lamports / 1e9).toFixed(4)} SOL for ~$${targetUsd} USDC`);
  const q: any = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${lamports}&slippageBps=50`)).json();
  if (!q.outAmount) throw new Error("quote failed: " + JSON.stringify(q).slice(0, 200));
  console.log(`quote: out ${(Number(q.outAmount) / 1e6).toFixed(4)} USDC (min ${(Number(q.otherAmountThreshold) / 1e6).toFixed(4)}), impact ${q.priceImpactPct}`);
  const s: any = await (await fetch("https://lite-api.jup.ag/swap/v1/swap", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: funder.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })).json();
  if (!s.swapTransaction) throw new Error("swap build failed: " + JSON.stringify(s).slice(0, 200));
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
  tx.sign([funder]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const bh = await conn.getLatestBlockhash();
  const res = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  console.log(`swap ${res.value.err ? "FAILED " + JSON.stringify(res.value.err) : "confirmed"}: ${sig.slice(0, 16)}…`);
})().catch(e => { console.error("ERR", String(e).slice(0, 300)); process.exit(1); });
