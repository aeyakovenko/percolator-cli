import { Connection, PublicKey } from "@solana/web3.js";
import { parseMarketGroup, MARKET_GROUP_OFF, MG } from "../src/v16/index.js";

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const m = new PublicKey("HgpvbLJhEZhtDAR25XWnGYMAr7MKMT1Zzpv5HGUrzbVq");
  const ai = await conn.getAccountInfo(m, "confirmed");
  if (!ai) { console.log("NO MARKET"); return; }
  const d = Buffer.from(ai.data);
  console.log("data.length =", d.length);
  console.log("mode =", d[MARKET_GROUP_OFF + MG.mode]);
  console.log("vault =", d.readBigUInt64LE(MARKET_GROUP_OFF + MG.vault));
  console.log("insurance =", d.readBigUInt64LE(MARKET_GROUP_OFF + MG.insurance));
  const mg: any = parseMarketGroup(d);
  console.log("assetSlotCapacity =", mg.assetSlotCapacity);
  console.log("asset[0].effectivePrice =", mg.assets[0].effectivePrice);
  console.log("asset[0].oracleMode =", mg.assets[0].oracleMode);
  console.log("OK — parses under new wrapper");
})();
