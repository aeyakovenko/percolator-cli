import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const F = { "BTC/USD":"e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", "SOL/USD":"ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" };
(async()=>{const now=Math.floor(Date.now()/1000);for(const[n,fid]of Object.entries(F)){const r=await conn.getProgramAccounts(RECEIVER,{commitment:"confirmed",filters:[{memcmp:{offset:41,bytes:bs58.encode(Buffer.from(fid,"hex"))}}]});let best:any=null;for(const{pubkey,account}of r){const d=account.data;if(d.length<134||d[40]!==1)continue;const age=now-Number(d.readBigInt64LE(93));if(!best||age<best.age)best={addr:pubkey,age,px:Number(d.readBigInt64LE(73))*Math.pow(10,d.readInt32LE(89))};}
if(best)console.log(`${n}: ${best.addr.toBase58()} $${best.px.toFixed(2)} age=${best.age}s`);else console.log(`${n}: none`);}process.exit(0);})().catch(e=>{console.error(String(e).slice(0,200));process.exit(1)});
