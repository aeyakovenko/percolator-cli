const MAX_SECRET_LIST_BYTES = 256 * 1024;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

function fail(message) {
  console.error(`Fly release gate failed: ${message}`);
  process.exit(1);
}

const requiredNames = process.argv.slice(2);
if (
  requiredNames.length === 0
  || requiredNames.some((name) => !SECRET_NAME.test(name))
  || new Set(requiredNames).size !== requiredNames.length
) {
  fail("expected unique valid required secret names");
}

let rawSecrets = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  rawSecrets += chunk;
  if (Buffer.byteLength(rawSecrets, "utf8") > MAX_SECRET_LIST_BYTES) {
    fail("secret metadata response exceeds 256 KiB");
  }
}

let records;
try {
  records = JSON.parse(rawSecrets);
} catch {
  fail("secret metadata response is not valid JSON");
}
if (!Array.isArray(records)) fail("secret metadata response is not a list");

const availableNames = new Set();
for (const record of records) {
  const name = record?.Name ?? record?.name;
  if (typeof name !== "string" || !SECRET_NAME.test(name)) {
    fail("secret metadata contains an invalid name");
  }
  if (availableNames.has(name)) fail("secret metadata contains a duplicate name");
  availableNames.add(name);
}

const missing = requiredNames.filter((name) => !availableNames.has(name));
if (missing.length > 0) fail(`missing required secret names: ${missing.join(", ")}`);

console.log(`Verified required Fly secret names: ${requiredNames.join(", ")}.`);
