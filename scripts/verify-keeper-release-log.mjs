const MAX_LOG_BYTES = 4 * 1024 * 1024;
const HEALTH_PREFIX = "NINJA_KEEPER_HEALTH ";

function fail(message) {
  console.error(`Keeper release proof failed: ${message}`);
  process.exit(1);
}

const [expectedMachineId, expectedSourceRevision, expectedReleaseId, notBeforeIso, mode = "strict", expectedOraclePriceSource] =
  process.argv.slice(2);

if (!/^[A-Za-z0-9_-]{6,64}$/.test(expectedMachineId ?? "")) fail("invalid machine ID");
if (!/^[0-9a-f]{7,64}$/.test(expectedSourceRevision ?? "")) fail("invalid source revision");
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(expectedReleaseId ?? "")) fail("invalid release ID");
if (mode !== "strict" && mode !== "legacy-rollback") fail("invalid proof mode");
if (!["pyth-solana-push", "pyth-hermes", "magicblock-demo"].includes(expectedOraclePriceSource)) {
  fail("invalid oracle price source");
}

const notBeforeMs = Date.parse(notBeforeIso ?? "");
if (!Number.isFinite(notBeforeMs)) fail("invalid release cutoff timestamp");

let rawLogs = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  rawLogs += chunk;
  if (Buffer.byteLength(rawLogs, "utf8") > MAX_LOG_BYTES) fail("log response exceeds 4 MiB");
}

function parseLogRecords(input) {
  const records = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const record = JSON.parse(input.slice(start, index + 1));
          if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
        } catch {
          // Malformed log records are not release proof.
        }
        start = -1;
      }
    }
  }
  return records;
}

let matchingEvent = null;
for (const record of parseLogRecords(rawLogs)) {
  const timestamp = record.timestamp ?? record.time ?? record.Timestamp;
  const timestampMs = Date.parse(typeof timestamp === "string" ? timestamp : "");
  if (!Number.isFinite(timestampMs) || timestampMs < notBeforeMs) continue;
  const instance = record.instance ?? record.machine_id ?? record.machineId ?? record.Instance;
  if (instance !== expectedMachineId) continue;
  const message = record.message ?? record.msg ?? record.Message;
  if (typeof message !== "string") continue;

  const prefixIndex = message.indexOf(HEALTH_PREFIX);
  if (prefixIndex >= 0) {
    try {
      const event = JSON.parse(message.slice(prefixIndex + HEALTH_PREFIX.length));
      if (event.event === "confirmed-push"
        && event.source === expectedSourceRevision
        && event.releaseId === expectedReleaseId
        && event.oraclePriceSource === expectedOraclePriceSource) {
        matchingEvent = { timestamp, legacy: false };
      }
    } catch {
      // A malformed application log is not release proof.
    }
  } else if (mode === "legacy-rollback" && message.includes("push+crank ✓")) {
    matchingEvent = { timestamp, legacy: true };
  }
}

if (!matchingEvent) {
  fail(mode === "strict"
    ? "no fresh matching confirmed-push marker"
    : "no fresh rollback push+crank confirmation");
}

console.log(
  `Verified ${matchingEvent.legacy ? "rollback" : "release"} keeper write on ${expectedMachineId} at ${matchingEvent.timestamp}.`,
);
