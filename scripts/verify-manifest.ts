/**
 * CLI #72/#77 — manifest integrity check. Run via `npm test`.
 *
 * Asserts the Bounty-5 manifest agrees with the single-source-of-truth params
 * (scripts/bounty5-params.ts), and that any `validation: "FAIL"` market carries a
 * `validationNote` explaining it (a deploy-time trade-probe failure is often a
 * transient oracle stall, NOT a broken market — don't let it silently mislead).
 *
 * Offline by default. Opt-in on-chain cross-check (parses the live WrapperConfigV16
 * and asserts the safety-critical values match the manifest + params):
 *     VERIFY_ONCHAIN=1 [SOLANA_RPC_URL=…] npm test
 *
 * Exits non-zero on any mismatch so CI / the deploy post-write guard fails loudly.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { BOUNTY5_PARAMS, MANIFEST_SAFETY_FIELDS } from "./bounty5-params.js";

// Resolve the manifest relative to the repo (this file lives in scripts/, the
// manifest sits at the repo root) so `npm test` works from any checkout — not just
// the author's ~/percolator-cli. Override with MANIFEST_PATH when needed.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = process.env.MANIFEST_PATH
  ?? path.join(REPO_ROOT, "mainnet-bounty5-v16-market.json");

const fails: string[] = [];
const ok: string[] = [];
function check(cond: boolean, msg: string) { (cond ? ok : fails).push(msg); }

const M = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

// 1. safety-critical immutables match the single source of truth
for (const f of MANIFEST_SAFETY_FIELDS) {
  const want = (BOUNTY5_PARAMS as any)[f];
  const got = M[f];
  check(Number(got) === Number(want), `manifest.${f} = ${got} (expected ${want})`);
}

// 2. fee-redirect + insurance seed match
check(Number(M?.fees?.feeRedirectToMarket0Bps) === BOUNTY5_PARAMS.feeRedirectToMarket0Bps,
  `fees.feeRedirectToMarket0Bps = ${M?.fees?.feeRedirectToMarket0Bps} (expected ${BOUNTY5_PARAMS.feeRedirectToMarket0Bps})`);
for (const d of (M.insurancePerDomain ?? [])) {
  check(Number(d.lamports) === BOUNTY5_PARAMS.insurancePerDomainLamports,
    `insurancePerDomain[${d.market}] = ${d.lamports} (expected ${BOUNTY5_PARAMS.insurancePerDomainLamports})`);
}

// 3. validation field hygiene (CLI #72 part 2): every market's validation is a known
//    enum, and if ANY is FAIL the manifest must carry a validationNote explaining it.
const VALID = new Set(["PASS", "FAIL"]);
const markets = M.markets ?? [];
for (const mk of markets) check(VALID.has(mk.validation), `markets[${mk.asset}].validation = ${mk.validation} (must be PASS|FAIL)`);
const anyFail = markets.some((mk: any) => mk.validation === "FAIL");
if (anyFail) {
  check(typeof M.validationNote === "string" && M.validationNote.length > 0,
    `markets have validation=FAIL but no manifest.validationNote explains it`);
}

// 4. on-chain cross-check (opt-in) — the real safety net: manifest must match the
//    deployed WrapperConfigV16, so a doctored manifest can't misrepresent the market.
async function onchain() {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { parseWrapperConfig } = await import("../src/v16/parsers.js");
  const rpc = process.env.SOLANA_RPC_URL
    ?? (M.network === "mainnet" ? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim()}` : "https://api.devnet.solana.com");
  const conn = new Connection(rpc, "confirmed");
  const buf = Buffer.from((await conn.getAccountInfo(new PublicKey(M.market), "confirmed"))!.data);
  const wc: any = parseWrapperConfig(buf);
  check(Number(wc.permissionlessResolveStaleSlots) === BOUNTY5_PARAMS.permissionlessResolveStaleSlots,
    `on-chain permissionlessResolveStaleSlots = ${wc.permissionlessResolveStaleSlots} (expected ${BOUNTY5_PARAMS.permissionlessResolveStaleSlots})`);
  check(Number(wc.forceCloseDelaySlots) === BOUNTY5_PARAMS.forceCloseDelaySlots,
    `on-chain forceCloseDelaySlots = ${wc.forceCloseDelaySlots} (expected ${BOUNTY5_PARAMS.forceCloseDelaySlots})`);
  check(Number(wc.feeRedirectToMarket0Bps) === BOUNTY5_PARAMS.feeRedirectToMarket0Bps,
    `on-chain feeRedirectToMarket0Bps = ${wc.feeRedirectToMarket0Bps} (expected ${BOUNTY5_PARAMS.feeRedirectToMarket0Bps})`);
}

(async () => {
  if (process.env.VERIFY_ONCHAIN === "1") { try { await onchain(); } catch (e: any) { fails.push(`on-chain check errored: ${e.message ?? e}`); } }
  console.log(`manifest: ${MANIFEST_PATH}`);
  for (const o of ok) console.log(`  ✅ ${o}`);
  for (const f of fails) console.log(`  ❌ ${f}`);
  console.log(`\n${fails.length === 0 ? "✅ manifest OK" : `🚨 ${fails.length} manifest issue(s)`}  (${ok.length} checks passed)`);
  process.exit(fails.length === 0 ? 0 : 1);
})();
