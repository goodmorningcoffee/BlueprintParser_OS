// [refactor jul23 P5.1-ε] Pin scripts/rollback.sh v1 = READ-ONLY / ADVISORY. It resolves the
// current + target digest, gates on ECR presence + the additive schema-cutover re-affirm, and
// PRINTS the exact owner command sequence — never mutating. The mock `aws` stub only answers
// read-only verbs; any mutation verb would hit its unexpected-call trap, so a green run proves
// no mutation was attempted. `npm` is stubbed for the schema-cutover re-affirm.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CURRENT = `sha256:${"a".repeat(64)}`;
const TARGET = `sha256:${"b".repeat(64)}`;
let fixtureDir;
let logPath;
let ledgerPath;

const mockAws = `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
# Parse the --task-definition value (bare family for the arn lookup, arn for the image lookup).
td=""
prev=""
for a in "$@"; do
  if [ "\${prev}" = "--task-definition" ]; then td="\${a}"; fi
  prev="\${a}"
done
case "\${1:-} \${2:-}" in
  "sts get-caller-identity") echo "\${MOCK_CALLER_ACCOUNT:-123456789012}" ;;
  "ecs describe-services")
    echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:50" ;;
  "ecs describe-task-definition")
    if [[ "$*" == *taskDefinitionArn* ]]; then
      echo "arn:aws:ecs:us-east-1:123456789012:task-definition/\${td}:60"
    else
      if [[ "\${td}" == *:50* ]]; then
        echo "123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@\${MOCK_CURRENT_DIGEST:-${CURRENT}}"
      else
        echo "123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@\${MOCK_FAMILY_DIGEST:-\${MOCK_CURRENT_DIGEST:-${CURRENT}}}"
      fi
    fi ;;
  "ecr describe-images")
    if [ "\${MOCK_TARGET_MISSING:-0}" = 1 ]; then exit 1; else exit 0; fi ;;
  *) echo "unexpected mock AWS call: $*" >&2; exit 97 ;;
esac
`;

const mockNpm = `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = run ]; then
  if [ -n "\${MOCK_FAIL_GATE:-}" ] && [ "\${2:-}" = "\${MOCK_FAIL_GATE}" ]; then
    echo "stub gate failure: \${2}" >&2
    exit 1
  fi
fi
exit 0
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-rollback-"));
  logPath = path.join(fixtureDir, "commands.log");
  ledgerPath = path.join(fixtureDir, "deploy-ledger.jsonl");
  await Promise.all([
    writeFile(path.join(fixtureDir, "aws"), mockAws),
    writeFile(path.join(fixtureDir, "npm"), mockNpm),
  ]);
  await Promise.all([
    chmod(path.join(fixtureDir, "aws"), 0o755),
    chmod(path.join(fixtureDir, "npm"), 0o755),
  ]);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([rm(ledgerPath, { force: true }), writeFile(logPath, "")]);
});

function run(args, extraEnv = {}) {
  return spawnSync("bash", ["scripts/rollback.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      MOCK_COMMAND_LOG: logPath,
      BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
      BP_DEPLOY_LEDGER_FILE: ledgerPath,
      MOCK_CURRENT_DIGEST: CURRENT,
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECR_REPO: "beaver-app",
      ECS_CLUSTER: "beaver-cluster",
      ECS_SERVICE: "beaver-app",
      ...extraEnv,
    },
  });
}

async function readLog() {
  return readFile(logPath, "utf8");
}

const MUTATION_VERBS = /update-service|run-task|register-task-definition|deregister|delete-|put-|create-/u;

test("advises rolling to an explicit target that needs Terraform re-registration", async () => {
  const result = run([TARGET]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ROLLBACK PLAN \(ADVISORY/u);
  assert.ok(result.stdout.includes(`current bound digest : ${CURRENT}`));
  assert.ok(result.stdout.includes(`rollback-to digest   : ${TARGET}`));
  assert.match(result.stdout, /target registered as latest across families: 0\/4/u);
  assert.match(result.stdout, /Re-register it via Terraform FIRST/u);
  // The exact owner cohort sequence is printed with both digests.
  assert.ok(result.stdout.includes(`./deploy.sh preflight-outage ${CURRENT} ${TARGET}`));
  assert.ok(result.stdout.includes(`./deploy.sh bind-quiescent ${TARGET}`));
  assert.ok(result.stdout.includes(`./deploy.sh verify-restored ${TARGET}`));
  // Read-only: no mutation verb was ever issued.
  const log = await readLog();
  assert.doesNotMatch(log, MUTATION_VERBS);
});

test("wrong-digest: refuses (and prints NO plan) when the target is absent from ECR", async () => {
  const result = run([TARGET], { MOCK_TARGET_MISSING: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not present in the beaver-app ECR repository/u);
  assert.doesNotMatch(result.stdout, /ROLLBACK PLAN/u);
  const log = await readLog();
  assert.doesNotMatch(log, MUTATION_VERBS);
});

test("refuses when the app is already bound to the requested target", async () => {
  const result = run([CURRENT]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already bound to .*; nothing to roll back/u);
  assert.doesNotMatch(result.stdout, /ROLLBACK PLAN/u);
});

test("refuses (no plan) when the additive schema-cutover guarantee is not green", async () => {
  const result = run([TARGET], { MOCK_FAIL_GATE: "check:schema-cutover" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema-cutover policy is not green/u);
  assert.doesNotMatch(result.stdout, /ROLLBACK PLAN/u);
});

test("derives the rollback target from the deploy ledger when no digest is given", async () => {
  // A prior publish recorded CURRENT superseding TARGET.
  const record = {
    version: 1, event: "publish", digest: CURRENT, previousDigest: TARGET,
    head: "unknown", account: "123456789012", region: "us-east-1", recordedAtEpoch: 1,
  };
  await writeFile(ledgerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`rollback-to digest   : ${TARGET}`));
  assert.ok(result.stdout.includes(`./deploy.sh verify-restored ${TARGET}`));
});

test("refuses when no explicit target and the ledger has no usable previous digest", async () => {
  // Empty ledger, no argument.
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not determine a rollback target/u);
  assert.doesNotMatch(result.stdout, /ROLLBACK PLAN/u);
});

test("advises the direct cohort when all four families already pin the target", async () => {
  const result = run([TARGET], { MOCK_FAMILY_DIGEST: TARGET });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /target registered as latest across families: 4\/4/u);
  assert.match(result.stdout, /All four task-definition families already have their latest/u);
  assert.doesNotMatch(result.stdout, /Re-register it via Terraform FIRST/u);
  assert.ok(result.stdout.includes(`./deploy.sh preflight-outage ${CURRENT} ${TARGET}`));
});

test("usage exits 64 for too many arguments", async () => {
  const result = run([TARGET, "extra"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage:/u);
});
