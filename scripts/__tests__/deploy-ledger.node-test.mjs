// [refactor jul23 P5.1-β] Pin the previous-digest printout + append-only deploy ledger added to
// `deploy.sh publish`. Purely additive over the α freeze: no AWS mutation, read-only digest
// resolution via the ecs-schema-tools helpers, and an owner-local JSONL audit ledger keyed by
// account+region (.deploy.env-configurable via BP_DEPLOY_LEDGER_FILE). Verified through the real
// script with the sanctioned `aws`/`docker` PATH stubs; nothing real is ever invoked.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const NEW_DIGEST = `sha256:${"a".repeat(64)}`;
const PREVIOUS_DIGEST = `sha256:${"c".repeat(64)}`;
let fixtureDir;
let logPath;
let ledgerPath;

// Publish-path stub that ALSO resolves a currently-bound service digest, so the β previous-digest
// lookup (bp_current_bound_digest -> describe-services -> describe-task-definition) succeeds.
const mockAws = `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
case "\${1:-} \${2:-}" in
  "sts get-caller-identity")
    echo "\${MOCK_CALLER_ACCOUNT:-123456789012}"
    ;;
  "ecr get-login-password")
    echo mock-password
    ;;
  "ecr describe-images")
    if [[ "$*" == *imageDigest* ]]; then
      echo "\${MOCK_IMAGE_DIGEST:-${NEW_DIGEST}}"
    else
      exit 255
    fi
    ;;
  "ecs describe-services")
    # bp_service_task_definition asks for services[0].taskDefinition.
    echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:41"
    ;;
  "ecs describe-task-definition")
    # bp_task_definition_image asks for containerDefinitions[0].image.
    echo "123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@\${MOCK_PREVIOUS_DIGEST:-${PREVIOUS_DIGEST}}"
    ;;
  *)
    echo "unexpected mock AWS call: $*" >&2
    exit 97
    ;;
esac
`;

const mockDocker = `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = login ]; then
  read -r _password
fi
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-deploy-ledger-"));
  logPath = path.join(fixtureDir, "commands.log");
  ledgerPath = path.join(fixtureDir, "deploy-ledger.jsonl");
  await Promise.all([
    writeFile(path.join(fixtureDir, "aws"), mockAws),
    writeFile(path.join(fixtureDir, "docker"), mockDocker),
  ]);
  await Promise.all([
    chmod(path.join(fixtureDir, "aws"), 0o755),
    chmod(path.join(fixtureDir, "docker"), 0o755),
  ]);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

// The ledger is append-only by design; give each test a fresh one so per-test counts are exact.
beforeEach(async () => {
  await rm(ledgerPath, { force: true });
});

async function publish(extraEnv = {}) {
  await writeFile(logPath, "");
  const result = spawnSync("bash", ["deploy.sh", "publish"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      MOCK_COMMAND_LOG: logPath,
      BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
      BP_DEPLOY_LEDGER_FILE: ledgerPath,
      BP_IMAGE_TAG: "deploy-ledger-test",
      BP_SKIP_PREFLIGHT: "1",
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECR_REPO: "beaver-app",
      // Provide service coordinates so the previous-digest lookup engages.
      ECS_CLUSTER: "beaver-cluster",
      ECS_SERVICE: "beaver-app",
      ...extraEnv,
    },
  });
  return { ...result, log: await readFile(logPath, "utf8") };
}

async function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  const text = await readFile(ledgerPath, "utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

test("publish prints the currently bound digest as the rollback-target previous digest", async () => {
  const result = await publish();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Previously bound app digest: ${PREVIOUS_DIGEST}`, "u"));
});

test("publish appends one well-formed append-only ledger record of the transition", async () => {
  await publish();
  const records = await readLedger();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.version, 1);
  assert.equal(record.event, "publish");
  assert.equal(record.digest, NEW_DIGEST);
  assert.equal(record.previousDigest, PREVIOUS_DIGEST);
  assert.equal(record.account, "123456789012");
  assert.equal(record.region, "us-east-1");
  assert.equal(typeof record.recordedAtEpoch, "number");
});

test("the deploy ledger is append-only across successive publishes", async () => {
  await publish({ BP_IMAGE_TAG: "deploy-ledger-test-1" });
  await publish({ BP_IMAGE_TAG: "deploy-ledger-test-2" });
  await publish({ BP_IMAGE_TAG: "deploy-ledger-test-3" });
  const records = await readLedger();
  assert.equal(records.length, 3);
  assert.ok(records.every((record) => record.event === "publish" && record.digest === NEW_DIGEST));
});

test("the deploy ledger is created owner-only (0600)", async () => {
  await publish();
  const info = await stat(ledgerPath);
  assert.equal(info.mode & 0o777, 0o600);
});

test("a bad resolved digest never writes a ledger record (validated before append)", async () => {
  const result = await publish({ MOCK_IMAGE_DIGEST: "sha256:not-a-digest" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected an exact sha256 image digest/u);
  const records = await readLedger();
  assert.equal(records.length, 0);
});
