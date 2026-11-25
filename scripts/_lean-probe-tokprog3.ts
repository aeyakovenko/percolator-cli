import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { LEAN_DEVNET, PORTFOLIO_SIZE, assertDevnet, parseDex, parsePortfolio, initPortfolio, depositCollateral, snapshotDex, checkDexInvariants } from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_DEVNET.percolator;
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const DEX = new PublicKey("7iu9Yga379XqZ6s4buzh2cZmbc9examJF75NdzgPKzM3");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`,"utf8"))));
async function main(){
  await assertDevnet(conn);
  const dex=parseDex(Buffer.from((await conn.getAccountInfo(DEX))!.data));
  const owner=Keypair.generate(), pfl=Keypair.generate();
  const lam=await conn.getMinimumBalanceForRentExemption(PORTFOLIO_SIZE);
  const vault0=BigInt((await conn.getTokenAccountBalance(dex.vault)).value.amount);
  await sendAndConfirmTransaction(conn,new Transaction().add(
    SystemProgram.createAccount({fromPubkey:funder.publicKey,newAccountPubkey:pfl.publicKey,lamports:lam,space:PORTFOLIO_SIZE,programId:P}),
    initPortfolio(P,{dex:DEX,portfolio:pfl.publicKey,owner:owner.publicKey})),[funder,pfl,owner],{commitment:"confirmed"});
  const sig=await sendAndConfirmTransaction(conn,new Transaction().add(
    depositCollateral(P,{dex:DEX,mint:dex.quoteMint,vault:dex.vault,tokenProgram:NOOP},
      {portfolio:pfl.publicKey,depositor:owner.publicKey,sourceToken:Keypair.generate().publicKey,amount:1_000_000_000n})),
    [funder,owner],{commitment:"confirmed"});
  const vault1=BigInt((await conn.getTokenAccountBalance(dex.vault)).value.amount);
  const cap=parsePortfolio(Buffer.from((await conn.getAccountInfo(pfl.publicKey))!.data)).capital;
  console.log(`CONFIRMED on-chain (sig ${sig.slice(0,16)}…):`);
  console.log(`  portfolio.capital credited: ${cap}  (deposited 1e9 via tokenProgram=Noop, source was a random non-token key)`);
  console.log(`  real SPL vault: before=${vault0} after=${vault1}  delta=${vault1-vault0}  (NO tokens moved)`);
  const s=await snapshotDex(conn,P,DEX);
  const rep=checkDexInvariants(s.dex,s.vaultTokenBalance,s.markets.map(m=>m.data),s.portfolios.map(p=>p.data));
  console.log(`  dex invariants now: ${rep.ok?"OK":"VIOLATED -> "+rep.problems.join("; ")}`);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
