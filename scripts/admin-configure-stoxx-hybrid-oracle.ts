import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import { encConfigureHybridOracle, ORACLE_LEG_FLAG_DIVIDE_LEG3 } from "../src/v16/index.js";

(async () => {
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`,"utf8").trim()}`, "confirmed");
  const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
  const PROG = new PublicKey(M.programId);
  const MARKET = new PublicKey(M.market);
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const FEED_STOXX_EUR = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
  const FEED_EUR_USD   = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
  const FEED_SOL_USD   = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
  const ACCT_STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
  const ACCT_EUR   = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
  const ACCT_SOL   = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
  const slot = BigInt(await conn.getSlot("confirmed"));

  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      new TransactionInstruction({ programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: MARKET, isSigner: false, isWritable: true },
        { pubkey: ACCT_STOXX, isSigner: false, isWritable: false },
        { pubkey: ACCT_EUR, isSigner: false, isWritable: false },
        { pubkey: ACCT_SOL, isSigner: false, isWritable: false },
      ], data: encConfigureHybridOracle({
        assetIndex: 0, nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now() / 1000)),
        oracleLegCount: 3, oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3,
        maxStalenessSecs: 300n, hybridSoftStaleSlots: 200n,
        markEwmaHalflifeSlots: 300n, markMinFee: 500n,
        invert: 1, unitScale: 0, confFilterBps: 100,
        oracleLegFeeds: [FEED_STOXX_EUR, FEED_EUR_USD, FEED_SOL_USD],
      }) }),
    ), [admin], { commitment: "confirmed", skipPreflight: true });
    console.log("✅ ConfigureHybridOracle:", sig);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const m = msg.match(/"Custom":(\d+)/);
    console.log("⚠️", m ? "Custom:"+m[1] : msg.slice(0, 200));
  }
})();
