/**
 * Install / refresh the cron entry for the bounty 2 mainnet tick.
 *
 * Adds (or replaces) one crontab line:
 *
 *   * * * * * /usr/bin/timeout 50 sh -c 'cd <CLI_DIR> && SOLANA_RPC_URL=... PERCOLATOR_DIR=<CLI_DIR> /path/to/npx tsx scripts/mainnet-bounty2-tick.ts >> ~/.cache/percolator/bounty2-cron.stderr.log 2>&1'
 *
 * The `timeout 50` wrapper is critical — last cron generation hung when
 * sendAndConfirmTransaction blocked on a stalled RPC, leaving 4-deep
 * orphan process trees. 50 sec leaves 10 sec slack inside the 60-sec
 * minutely tick.
 *
 * Idempotent: re-running rewrites just our managed line, leaves any
 * unrelated cron entries untouched.
 *
 * Run: npx tsx scripts/mainnet-bounty2-cron-install.ts
 */
import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const TAG = "# percolator-bounty2-tick";

function which(cmd: string): string {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${cmd} not found in PATH`);
  }
}

const cliDir = process.cwd();
if (!fs.existsSync(path.join(cliDir, "mainnet-bounty2-market.json"))) {
  throw new Error(
    `Run this from the percolator-cli directory after setup-mainnet-bounty2.ts has written mainnet-bounty2-market.json. CWD: ${cliDir}`
  );
}

const npx = which("npx");
const timeoutBin = which("timeout"); // /usr/bin/timeout
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const logDir = path.join(os.homedir(), ".cache", "percolator");
fs.mkdirSync(logDir, { recursive: true });
const stderrLog = path.join(logDir, "bounty2-cron.stderr.log");

const cronLine =
  `* * * * * ${timeoutBin} 50 sh -c 'cd ${cliDir} && SOLANA_RPC_URL=${rpcUrl} PERCOLATOR_DIR=${cliDir} ${npx} tsx scripts/mainnet-bounty2-tick.ts >> ${stderrLog} 2>&1' ${TAG}`;

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
console.log(`Tick log (JSONL): tail -f ${path.join(logDir, "bounty2-tick.log")}`);
console.log("");
console.log("To remove: `crontab -l | grep -v percolator-bounty2-tick | crontab -`");
