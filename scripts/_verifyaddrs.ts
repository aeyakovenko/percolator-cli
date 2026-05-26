import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import * as fs from "fs";
const HOME = process.env.HOME!;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const PROG = new PublicKey(M.programId), MARKET = new PublicKey(M.market);
let bad = 0;
const ck = (label: string, got: string, want: string, extra = "") => { const ok = got === want; if (!ok) bad++; console.log(`  ${ok ? "✅" : "❌"} ${label.padEnd(22)} README/manifest=${want}  ${ok ? "" : `→ ACTUAL ${got}`}${extra}`); };
(async () => {
  // 1. vault authority PDA derivation
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROG);
  ck("Vault PDA (derived)", vaultPda.toBase58(), M.vaultPda);
  // 2. vault ATA derivation
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultPda, true);
  ck("Vault ATA (derived)", vaultAta.toBase58(), M.vault);
  // 3. accounts exist on-chain with the right owner
  for (const [label, addr, owner] of [
    ["Program", M.programId, "BPFLoaderUpgradeab1e11111111111111111111111"],
    ["Market", M.market, M.programId],
    ["Keeper pf", M.keeperPortfolio, M.programId],
  ] as [string, string, string][]) {
    const ai = await conn.getAccountInfo(new PublicKey(addr), "confirmed");
    const ownerOk = !!ai && ai.owner.toBase58() === owner;
    if (!ownerOk) bad++;
    console.log(`  ${ownerOk ? "✅" : "❌"} ${label.padEnd(22)} ${addr}  ${ai ? `owner=${ai.owner.toBase58().slice(0,8)}…` : "<MISSING>"}`);
  }
  // 4. vault ATA holds the insurance wSOL
  try { const acc = await getAccount(conn, vaultAta, "confirmed"); console.log(`  ✅ Vault ATA balance       ${(Number(acc.amount) / 1e9).toFixed(4)} wSOL  (mint ${acc.mint.toBase58().slice(0,6)}… owner ${acc.owner.toBase58().slice(0,6)}…)`); }
  catch (e: any) { bad++; console.log(`  ❌ Vault ATA not a token account: ${e.message}`); }
  // 5. keeper signer key matches the dedicated keypair file (if present)
  for (const f of ["bounty5-keeper.json"]) {
    const p = `${HOME}/percolator-cli/${f}`;
    if (fs.existsSync(p)) { const { Keypair } = await import("@solana/web3.js"); const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8")))); ck(`Keeper key (${f})`, kp.publicKey.toBase58(), M.keeper); }
    else console.log(`  ·  keeper keypair ${f} not present locally (skip)`);
  }
  // 6. oracle accounts exist
  for (const mk of M.markets ?? []) for (const o of mk.oracleAccounts ?? []) {
    const ai = await conn.getAccountInfo(new PublicKey(o), "confirmed");
    if (!ai) bad++;
    console.log(`  ${ai ? "✅" : "❌"} oracle ${mk.asset.padEnd(15)} ${o}  ${ai ? `(${ai.data.length}B)` : "<MISSING>"}`);
  }
  console.log(bad === 0 ? "\n✅ all Bounty-6 addresses verified on-chain" : `\n🚨 ${bad} address problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error(e.message || e); process.exit(1); });
