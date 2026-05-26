import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  BOUNTY5_FORCE_CLOSE_DELAY_SLOTS,
  BOUNTY5_FEE_REDIRECT_TO_MARKET_0_BPS,
  BOUNTY5_MAINNET_MARKET,
  BOUNTY5_MAINNET_PROGRAM,
  BOUNTY5_PERM_RESOLVE_STALE_SLOTS,
  LEGACY_MAX_ACCRUAL_PERM_RESOLVE_CAP,
} from "../src/v16/bounty5-manifest-constants.js";
import { parseWrapperConfig } from "../src/v16/parsers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

type MarketEntry = {
  asset: string;
  validation: string;
  validationNote?: string;
  oracleLegCount: number;
  legFeedIds: string[];
  oracleAccounts: string[];
};

type Manifest = {
  network: string;
  programId: string;
  market: string;
  permissionlessResolveStaleSlots: number;
  forceCloseDelaySlots: number;
  fees: { feeRedirectToMarket0Bps: number };
  markets: MarketEntry[];
};

function loadManifest(name: string): Manifest {
  const p = path.join(ROOT, name);
  return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
}

function checkManifestFile(file: string, expectNetwork: string): void {
  const m = loadManifest(file);
  assert(m.network === expectNetwork, `${file}: network`);
  assert(
    m.permissionlessResolveStaleSlots === BOUNTY5_PERM_RESOLVE_STALE_SLOTS,
    `${file}: permissionlessResolveStaleSlots must be ${BOUNTY5_PERM_RESOLVE_STALE_SLOTS} (got ${m.permissionlessResolveStaleSlots})`,
  );
  assert(
    m.permissionlessResolveStaleSlots !== LEGACY_MAX_ACCRUAL_PERM_RESOLVE_CAP,
    `${file}: must not use legacy v12.21 cap of ${LEGACY_MAX_ACCRUAL_PERM_RESOLVE_CAP} slots`,
  );
  assert(
    m.forceCloseDelaySlots === BOUNTY5_FORCE_CLOSE_DELAY_SLOTS,
    `${file}: forceCloseDelaySlots`,
  );
  assert(
    m.fees.feeRedirectToMarket0Bps === BOUNTY5_FEE_REDIRECT_TO_MARKET_0_BPS,
    `${file}: feeRedirectToMarket0Bps`,
  );
  for (const entry of m.markets) {
    assert(
      entry.legFeedIds.length === entry.oracleLegCount,
      `${file} ${entry.asset}: legFeedIds length`,
    );
    assert(
      entry.oracleAccounts.length === entry.oracleLegCount,
      `${file} ${entry.asset}: oracleAccounts length`,
    );
  }
}

async function verifyOnChain(): Promise<void> {
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const info = await conn.getAccountInfo(new PublicKey(BOUNTY5_MAINNET_MARKET), "confirmed");
  assert(!!info?.data, "mainnet market account missing");
  const cfg = parseWrapperConfig(Buffer.from(info!.data));
  assert(
    cfg.permissionlessResolveStaleSlots === BigInt(BOUNTY5_PERM_RESOLVE_STALE_SLOTS),
    `on-chain permissionlessResolveStaleSlots: got ${cfg.permissionlessResolveStaleSlots}, want ${BOUNTY5_PERM_RESOLVE_STALE_SLOTS}`,
  );
  assert(
    cfg.forceCloseDelaySlots === BigInt(BOUNTY5_FORCE_CLOSE_DELAY_SLOTS),
    "on-chain forceCloseDelaySlots",
  );
  console.log("on-chain wrapper config matches manifest constants");
}

async function main(): Promise<void> {
  console.log("verify-bounty5-manifest\n");
  checkManifestFile("mainnet-bounty5-v16-market.json", "mainnet");
  console.log("OK mainnet-bounty5-v16-market.json");
  checkManifestFile("bounty5-v16-devnet.json", "devnet");
  console.log("OK bounty5-v16-devnet.json");
  const mainnet = loadManifest("mainnet-bounty5-v16-market.json");
  assert(mainnet.programId === BOUNTY5_MAINNET_PROGRAM, "mainnet programId");
  assert(mainnet.market === BOUNTY5_MAINNET_MARKET, "mainnet market");
  const failed = mainnet.markets.filter((m) => m.validation === "FAIL");
  if (failed.length > 0) {
    for (const m of failed) {
      assert(
        typeof m.validationNote === "string" && m.validationNote.length > 20,
        `mainnet ${m.asset}: FAIL must include validationNote`,
      );
    }
    console.log(`OK mainnet FAIL markets documented (${failed.length})`);
  }
  if (process.env.VERIFY_CHAIN === "1") {
    await verifyOnChain();
  } else {
    console.log("skip on-chain (set VERIFY_CHAIN=1 to verify mainnet RPC)");
  }
  console.log("\nAll bounty5 manifest checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
