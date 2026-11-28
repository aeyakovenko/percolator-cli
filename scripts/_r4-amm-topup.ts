/** Top up the round-4 AMM vault's LP portfolio to a target total value (capital + locked + posPnl). --live to send. */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import { depositCollateral, deriveDexVault, parseDex, parsePortfolio, type VaultAccounts } from "../src/lean/index.js";
const LIVE = process.argv.includes("--live");
const TARGET = BigInt(Math.round(Number(process.env.TARGET_USD ?? "10") * 1e6));
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync("lean-mainnet-r4.json", "utf8"));
const P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), USDC = new PublicKey(m.usdc), LPP = new PublicKey(m.ammVault.lpPortfolio);
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const V: VaultAccounts = { dex: DEX, mint: USDC, vault: deriveDexVault(P, DEX)[0] };
const U = (n: bigint) => (Number(n) / 1e6).toFixed(4);
(async () => {
  const p = parsePortfolio(Buffer.from((await conn.getAccountInfo(LPP))!.data));
  if (!p.owner.equals(funder.publicKey)) throw new Error("LP portfolio is not funder-owned");
  const value = p.capital + p.totalLockedMm + p.legs.reduce((a, l) => a + l.posPnl, 0n);
  const add = TARGET > value ? TARGET - value : 0n;
  const fTok = await getAssociatedTokenAddress(USDC, funder.publicKey);
  const have = (await getAccount(conn, fTok)).amount;
  console.log(`AMM LP value $${U(value)} -> target $${U(TARGET)}: deposit $${U(add)} (wallet $${U(have)})`);
  if (add === 0n) return;
  if (have < add) throw new Error("not enough USDC in wallet");
  if (!LIVE) { console.log("DRY: re-run with --live"); return; }
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(depositCollateral(P, V, { portfolio: LPP, depositor: funder.publicKey, sourceToken: fTok, amount: add })), [funder], { commitment: "confirmed" });
  const r = await conn.getMultipleAccountsInfoAndContext([DEX, V.vault, LPP], "confirmed");
  const d = parseDex(Buffer.from(r.value[0]!.data)), spl = Buffer.from(r.value[1]!.data).readBigUInt64LE(64), q = parsePortfolio(Buffer.from(r.value[2]!.data));
  console.log(`deposited ($${U(add)}) ${sig.slice(0, 16)}…  LP now $${U(q.capital + q.totalLockedMm)}  | DEX V=$${U(d.vaultBalance)} SPL=$${U(spl)} conserved=${d.vaultBalance === spl}`);
  m.ammVault.lpCapitalUsd = Number(q.capital + q.totalLockedMm) / 1e6; fs.writeFileSync("lean-mainnet-r4.json", JSON.stringify(m, null, 2) + "\n");
})().catch(e => { console.error("ERR", String(e).replace(/api-key=[^ "&]*/g, "api-key=***").slice(0, 300)); process.exit(1); });
