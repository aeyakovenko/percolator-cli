/**
 * Install / refresh the cron entry for bounty 4 (STOXX 50 ETF / SOL).
 * One per-minute line, `timeout 50` wrapper, same shape as bounty 3.
 */
import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const TAG = "# percolator-bounty4-tick";

function which(cmd: string): string {
  return execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim();
}

const cliDir = process.cwd();
if (!fs.existsSync(path.join(cliDir, "mainnet-bounty4-market.json"))) {
  throw new Error(`Run from percolator-cli/ after setup-mainnet-bounty4.ts has written the manifest. CWD: ${cliDir}`);
}

const npx = which("npx");
const timeoutBin = which("timeout");
const logDir = path.join(os.homedir(), ".cache", "percolator");
fs.mkdirSync(logDir, { recursive: true });
const stderrLog = path.join(logDir, "bounty4-cron.stderr.log");

const cronLine =
  `* * * * * ${timeoutBin} 50 sh -c 'cd ${cliDir} && PERCOLATOR_DIR=${cliDir} ${npx} tsx scripts/mainnet-bounty4-tick.ts >> ${stderrLog} 2>&1' ${TAG}`;

let existing = "";
try { existing = execSync("crontab -l", { encoding: "utf8" }); } catch { /* none */ }

const filtered = existing.split("\n").filter(l => !l.includes(TAG)).filter(l => l.trim() !== "").join("\n");
const next = (filtered ? filtered + "\n" : "") + cronLine + "\n";
const tmp = path.join(os.tmpdir(), `crontab.${process.pid}`);
fs.writeFileSync(tmp, next);
execSync(`crontab ${tmp}`);
fs.unlinkSync(tmp);

console.log("✓ bounty 4 cron entry installed:");
console.log(`    ${cronLine}`);
console.log("");
console.log(`Tick log: tail -f ${path.join(logDir, "bounty4-tick.log")}`);
console.log(`Stderr:   tail -f ${stderrLog}`);
console.log("");
console.log("To remove: `crontab -l | grep -v percolator-bounty4-tick | crontab -`");
