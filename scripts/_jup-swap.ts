/**
 * One-off: swap SOL -> USDC on mainnet via Jupiter, to fund the bounty insurance pot.
 *   SOLANA_RPC_URL=<mainnet> pnpm tsx scripts/_jup-swap.ts <solAmount>
 */
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const solAmount = parseFloat(process.argv[2] ?? "1");
const lamports = Math.round(solAmount * 1e9);

async function jget(url: string) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); }

async function main() {
  if (!conn.rpcEndpoint.includes("mainnet") && !conn.rpcEndpoint.includes("helius")) throw new Error("mainnet RPC required");
  console.log(`swapping ${solAmount} SOL -> USDC (wallet ${funder.publicKey.toBase58()})`);
  const q: any = await jget(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${lamports}&slippageBps=100`);
  const outUsdc = Number(q.outAmount) / 1e6;
  console.log(`quote: ${solAmount} SOL -> ${outUsdc.toFixed(4)} USDC (price impact ${q.priceImpactPct}%)`);
  const swapRes: any = await (await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: funder.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
  })).json();
  if (!swapRes.swapTransaction) throw new Error("no swapTransaction: " + JSON.stringify(swapRes).slice(0, 300));
  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
  tx.sign([funder]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
  console.log(`sent ${sig}, confirming...`);
  const bh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  // read resulting USDC balance
  const accs = await conn.getParsedTokenAccountsByOwner(funder.publicKey, { mint: new PublicKey(USDC) }, "confirmed");
  const bal = accs.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount), 0);
  console.log(`DONE sig ${sig} — wallet USDC balance: ${bal}`);
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
