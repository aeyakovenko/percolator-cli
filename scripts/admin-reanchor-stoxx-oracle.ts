import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import { encConfigureHybridOracle } from "../src/v16/instructions.js";
import { parseWrapperConfig } from "../src/v16/parsers.js";

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
  const PROG = new PublicKey(M.programId);
  const MARKET = new PublicKey(M.market);
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const ORACLES = M.asset0.oracleAccounts.map((a: string) => new PublicKey(a));

  // Read current oracle config from the market so we re-apply IDENTICAL params
  const ai = (await conn.getAccountInfo(MARKET, "confirmed"))!;
  const wc: any = parseWrapperConfig(Buffer.from(ai.data));
  console.log("current oracle_leg_count:", wc.oracleLegCount, "leg_flags:", wc.oracleLegFlags, "invert:", wc.invert,
              "halflife:", wc.markEwmaHalflifeSlots, "soft_stale:", wc.hybridSoftStaleSlots, "max_stale:", wc.maxStalenessSecs);
  const nowSlot = BigInt(await conn.getSlot("confirmed"));
  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  console.log("re-anchor: nowSlot=", nowSlot);

  const ix = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      ...ORACLES.map((a: PublicKey) => ({ pubkey: a, isSigner: false, isWritable: false })),
    ],
    data: encConfigureHybridOracle({
      assetIndex: 0,
      nowSlot, nowUnixTs: nowUnix,
      oracleLegCount: Number(wc.oracleLegCount),
      oracleLegFlags: Number(wc.oracleLegFlags),
      maxStalenessSecs: BigInt(wc.maxStalenessSecs),
      hybridSoftStaleSlots: BigInt(wc.hybridSoftStaleSlots),
      markEwmaHalflifeSlots: BigInt(wc.markEwmaHalflifeSlots),
      markMinFee: BigInt(wc.markMinFee),
      invert: Number(wc.invert),
      unitScale: Number(wc.unitScale),
      confFilterBps: Number(wc.confFilterBps),
      oracleLegFeeds: M.asset0.oracleLegFeeds as [string, string, string],
    } as any),
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ix,
  );
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], { skipPreflight: true });
    console.log("re-anchor OK:", sig);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.log("err msg:", msg.slice(0, 300));
    const sigm = msg.match(/Transaction (\w{32,})/);
    if (sigm) {
      await new Promise(r => setTimeout(r, 2500));
      const t = await conn.getTransaction(sigm[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("---logs---");
      console.log((t?.meta?.logMessages ?? []).slice(-15).join("\n"));
    }
  }
})();
