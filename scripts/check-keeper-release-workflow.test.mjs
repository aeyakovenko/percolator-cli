import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-keeper.yml", import.meta.url),
  "utf8",
);
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const flyTemplate = readFileSync(new URL("../fly.toml", import.meta.url), "utf8");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("release is manual-only, protected, app-explicit, and app-serialized", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /app:\n\s+description: Exact existing Fly application name\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /group: keeper-release-\$\{\{ inputs\.app \}\}/);
  assert.doesNotMatch(workflow, /ninja-oracle-keeper|d891e161f73358/);
});

test("release builds while the old keeper is live, then targets only the exact Machine", () => {
  const buildIndex = workflow.indexOf("docker buildx build");
  const updateIndex = workflow.indexOf('flyctl machine update "$EXPECTED_MACHINE_ID"');
  assert.ok(buildIndex >= 0, "candidate build is present");
  assert.ok(updateIndex > buildIndex, "candidate is built before the Machine update");
  assert.match(workflow, /existing started singleton Fly Machine ID/i);
  assert.match(workflow, /verify-fly-singleton\.mjs[\s\S]*started/);
  assert.equal(workflow.match(/flyctl machine update "\$EXPECTED_MACHINE_ID"/g)?.length, 2);
});

test("release never creates, clones, scales, starts, or stages another Machine", () => {
  assert.doesNotMatch(workflow, /--skip-start/);
  assert.doesNotMatch(workflow, /flyctl\s+(?:machine\s+)?(?:clone|run|scale|start)/);
  assert.doesNotMatch(workflow, /--ha(?:=|\s+)true/);
});

test("release requires explicit live target settings without changing them", () => {
  for (const name of [
    "PROGRAM_ID",
    "MARKET",
    "LP_PORTFOLIO",
    "KEEPER_MODE",
    "KEEPER_ASSETS_JSON",
    "ORACLE_PRICE_SOURCE",
  ]) {
    assert.match(workflow, new RegExp(`\\$env\\.${name}`));
  }
  assert.match(workflow, /\$env\.KEEPER_MODE == "live"/);
  assert.doesNotMatch(workflow, /--env "(?:PROGRAM_ID|MARKET|LP_PORTFOLIO|KEEPER_MODE|KEEPER_ASSETS_JSON)=/);
  assert.doesNotMatch(workflow, /(?:RPC_URL|KEEPER_SECRET_KEY|PYTH_API_KEY): \$\{\{ secrets\./);
});

test("release validates secret names and Hermes rollback requirements without values", () => {
  assert.match(workflow, /flyctl secrets list --app "\$EXPECTED_APP" --json/);
  assert.match(workflow, /verify-fly-secret-names\.mjs "\$\{required\[@\]\}"/);
  assert.match(workflow, /RPC_URL KEEPER_SECRET_KEY/);
  assert.match(workflow, /OLD_ORACLE_PRICE_SOURCE" = "pyth-hermes"/);
  assert.match(workflow, /required\+=\(PYTH_API_KEY\)/);
  assert.deepEqual(workflow.match(/\$\{\{ secrets\.[A-Z0-9_]+ \}\}/g), [
    "${{ secrets.FLY_API_TOKEN }}",
  ]);
  assert.doesNotMatch(workflow, /flyctl secrets set|--stage/);
});

test("release requires a fresh confirmed push and one explicit captured-image rollback", () => {
  assert.match(workflow, /rollback_confirmation/);
  assert.match(workflow, /test "\$ROLLBACK_CONFIRMATION" = "ROLLBACK"/);
  assert.match(workflow, /verify-keeper-release-log\.mjs/);
  assert.match(workflow, /steps\.preflight\.outputs\.old_image/);
  assert.match(workflow, /exit 1/);
});

test("release pins the selected oracle source and restores the captured source", () => {
  assert.match(workflow, /oracle_price_source:/);
  assert.match(workflow, /ORACLE_PRICE_SOURCE: \$\{\{ inputs\.oracle_price_source \}\}/);
  assert.match(workflow, /old_oracle_price_source=/);
  assert.match(workflow, /--env "ORACLE_PRICE_SOURCE=\$ORACLE_PRICE_SOURCE"/);
  assert.match(workflow, /--env "ORACLE_PRICE_SOURCE=\$\{\{ steps\.preflight\.outputs\.old_oracle_price_source \}\}"/);
});

test("release gates promotion and rollback on operational audits with positive floors", () => {
  assert.equal(workflow.match(/scripts\/check-current-market-health\.ts/g)?.length, 2);
  assert.match(workflow, /\[\[ "\$MINIMUM_LP_RISK_EQUITY_USDC" =~ \[1-9\] \]\]/);
  assert.match(workflow, /\[\[ "\$MINIMUM_DOMAIN_INSURANCE_USDC" =~ \[1-9\] \]\]/);
  assert.match(workflow, /Require a healthy operational audit immediately before promotion/);
  assert.match(workflow, /audit_market "Post-promotion"/);
  assert.match(workflow, /audit_market "Post-rollback"/);
});

test("Fly template is identity-free and contains no runtime configuration", () => {
  assert.doesNotMatch(flyTemplate, /^\s*app\s*=/m);
  assert.doesNotMatch(flyTemplate, /^\s*primary_region\s*=/m);
  assert.doesNotMatch(flyTemplate, /\[env\]/);
  assert.doesNotMatch(flyTemplate, /PROGRAM_ID|MARKET|LP_PORTFOLIO|RPC_URL|KEEPER_SECRET_KEY/);
  assert.match(flyTemplate, /strategy = "immediate"/);
});

test("container runs the explicit v16 keeper as PID 1 with frozen pnpm dependencies", () => {
  assert.match(dockerfile, /pnpm install --frozen-lockfile --prod=false/);
  assert.match(dockerfile, /CMD \["node", "--import", "tsx", "scripts\/oracle-keeper-v16\.ts"\]/);
  assert.doesNotMatch(dockerfile, /\bnpm (?:install|ci)\b|ENTRYPOINT|EXPOSE/);
  assert.doesNotMatch(
    dockerfile,
    /(?:PROGRAM_ID|MARKET|LP_PORTFOLIO|KEEPER_ASSETS_JSON|RPC_URL|KEEPER_SECRET_KEY)=/,
  );
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^scripts\/\*\.test\.\*$/m);
});

test("one release check composes every offline, type, and build gate", () => {
  assert.equal(packageJson.packageManager, "pnpm@11.25.0");
  assert.match(packageJson.scripts["release:check"], /^pnpm test /);
  for (const command of [
    "pnpm typecheck",
    "pnpm typecheck:keeper-core",
    "pnpm typecheck:tests",
    "pnpm typecheck:v16-health",
    "pnpm build",
  ]) {
    assert.ok(packageJson.scripts["release:check"].includes(command));
  }
});
