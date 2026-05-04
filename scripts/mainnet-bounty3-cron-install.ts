/**
 * Install / refresh the cron entry for the bounty 3 mainnet tick.
 *
 * Adds (or replaces) one crontab line:
 *
 *   * * * * * /usr/bin/timeout 50 sh -c 'cd <CLI_DIR> && SOLANA_RPC_URL=... PERCOLATOR_DIR=<CLI_DIR> /path/to/npx tsx scripts/mainnet-bounty3-tick.ts >> ~/.cache/percolator/bounty3-cron.stderr.log 2>&1'
 *
 * The `timeout 50` wrapper is critical — last cron generation hung when
 * sendAndConfirmTransaction blocked on a stalled RPC, leaving 4-deep
 * orphan process trees. 50 sec leaves 10 sec slack inside the 60-sec
 * minutely tick.
 *
 * Idempotent: re-running rewrites just our managed line, leaves any
 * unrelated cron entries untouched.
 *
 * Run: npx tsx scripts/mainnet-bounty3-cron-install.ts
 */
import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const TAG = "# percolator-bounty3-tick";

function which(cmd: string): string {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${cmd} not found in PATH`);
  }
}

const cliDir = process.cwd();
if (!fs.existsSync(path.join(cliDir, "mainnet-bounty3-market.json"))) {
  throw new Error(
    `Run this from the percolator-cli directory after setup-mainnet-bounty3.ts has written mainnet-bounty3-market.json. CWD: ${cliDir}`
  );
}

const npx = which("npx");
const timeoutBin = which("timeout"); // /usr/bin/timeout
const logDir = path.join(os.homedir(), ".cache", "percolator");
fs.mkdirSync(logDir, { recursive: true });
const stderrLog = path.join(logDir, "bounty3-cron.stderr.log");

// Don't pin SOLANA_RPC_URL — the tick auto-selects Helius (if ~/.helius
// has a key) and falls back to mainnet-beta public RPC if Helius fails.
const cronLine =
  `* * * * * ${timeoutBin} 50 sh -c 'cd ${cliDir} && PERCOLATOR_DIR=${cliDir} ${npx} tsx scripts/mainnet-bounty3-tick.ts >> ${stderrLog} 2>&1' ${TAG}`;

let existing = "";
try {
  existing = execSync("crontab -l", { encoding: "utf8" });
} catch {
  // No crontab yet — that's fine.
}

const filtered = existing
  .split("\n")
  .filter(line => !line.includes(TAG))
  .filter(line => line.trim() !== "")
  .join("\n");

const next = (filtered ? filtered + "\n" : "") + cronLine + "\n";

const tmp = path.join(os.tmpdir(), `crontab.${process.pid}`);
fs.writeFileSync(tmp, next);
execSync(`crontab ${tmp}`);
fs.unlinkSync(tmp);

console.log("✓ Cron entry installed:");
console.log(`    ${cronLine}`);
console.log("");
console.log(`Logs: tail -f ${stderrLog}`);
console.log(`Tick log (JSONL): tail -f ${path.join(logDir, "bounty3-tick.log")}`);
console.log("");
console.log("To remove: `crontab -l | grep -v percolator-bounty3-tick | crontab -`");
