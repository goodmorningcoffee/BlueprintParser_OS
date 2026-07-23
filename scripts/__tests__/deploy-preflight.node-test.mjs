// [refactor jul23 P5.1-γ] Pin the deploy preflight subcommand + its auto-invoke at the top of
// publish. Preflight is the fast, hermetic, no-DB local gate: git working-tree state (with the
// known owner-dirt allowlist + BP_ALLOW_DIRTY override), the fast CI gate set, tsc, and a
// recorded battery-green marker pinned to HEAD standing in for the heavy DB/build battery.
//
// Everything is hermetic PATH stubs (git/npm/npx for the gates; aws/docker for the publish
// auto-invoke), driven through the real deploy.sh by spawnSync. Nothing real is invoked.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const DIGEST = `sha256:${"a".repeat(64)}`;
let fixtureDir;
let logPath;
let markerPath;
let ledgerPath;

// git: only rev-parse HEAD and status --porcelain are exercised; MOCK_GIT_STATUS drives dirt.
const mockGit = `#!/usr/bin/env bash
set -euo pipefail
# Skip a leading "-C <dir>".
if [ "\${1:-}" = "-C" ]; then shift 2; fi
case "\${1:-} \${2:-}" in
  "rev-parse HEAD") echo "${HEAD}" ;;
  "status --porcelain") printf '%s' "\${MOCK_GIT_STATUS:-}" ;;
  *) echo "unexpected git call: $*" >&2; exit 97 ;;
esac
`;

// npm: only "run <gate>" is exercised; MOCK_FAIL_GATE makes exactly one gate fail closed.
const mockNpm = `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = run ]; then
  if [ -n "\${MOCK_FAIL_GATE:-}" ] && [ "\${2:-}" = "\${MOCK_FAIL_GATE}" ]; then
    echo "stub gate failure: \${2}" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`;

const mockNpx = `#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = tsc ] && [ "\${MOCK_TSC_FAIL:-0}" = 1 ]; then
  echo "stub tsc failure" >&2
  exit 1
fi
exit 0
`;

const mockAws = `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
case "\${1:-} \${2:-}" in
  "sts get-caller-identity") echo "\${MOCK_CALLER_ACCOUNT:-123456789012}" ;;
  "ecr get-login-password") echo mock-password ;;
  "ecr describe-images")
    if [[ "$*" == *imageDigest* ]]; then echo "${DIGEST}"; else exit 255; fi ;;
  *) echo "unexpected mock AWS call: $*" >&2; exit 97 ;;
esac
`;

const mockDocker = `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = login ]; then read -r _password; fi
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-deploy-preflight-"));
  logPath = path.join(fixtureDir, "commands.log");
  markerPath = path.join(fixtureDir, "battery-green.json");
  ledgerPath = path.join(fixtureDir, "deploy-ledger.jsonl");
  const stubs = { git: mockGit, npm: mockNpm, npx: mockNpx, aws: mockAws, docker: mockDocker };
  await Promise.all(Object.entries(stubs).map(([name, body]) => writeFile(path.join(fixtureDir, name), body)));
  await Promise.all(Object.keys(stubs).map((name) => chmod(path.join(fixtureDir, name), 0o755)));
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([rm(markerPath, { force: true }), rm(ledgerPath, { force: true }), writeFile(logPath, "")]);
});

async function writeMarker(head = HEAD) {
  const record = { version: 1, head, recordedAtEpoch: Math.floor(Date.now() / 1000), battery: ["vitest", "build"] };
  await writeFile(markerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function run(args, extraEnv = {}) {
  return spawnSync("bash", ["deploy.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      MOCK_COMMAND_LOG: logPath,
      BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
      BP_BATTERY_GREEN_FILE: markerPath,
      BP_DEPLOY_LEDGER_FILE: ledgerPath,
      BP_IMAGE_TAG: "deploy-preflight-test",
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECR_REPO: "beaver-app",
      ...extraEnv,
    },
  });
}

async function readLog() {
  return readFile(logPath, "utf8");
}

// ---- preflight subcommand: green path ----

test("preflight passes with a clean tree, green gates, and a HEAD-pinned marker", async () => {
  await writeMarker(HEAD);
  const result = run(["preflight"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deploy preflight passed/u);
  const log = await readLog();
  // Every fast gate + tsc actually ran.
  for (const gate of ["check:architecture", "check:project-security-policy", "check:schema-cutover", "check:lint-baseline", "test:scripts"]) {
    assert.ok(log.includes(`npm run ${gate}`), `expected the log to show 'npm run ${gate}'`);
  }
  assert.match(log, /npx tsc --noEmit/u);
});

// ---- preflight subcommand: fail-closed mutants ----

test("preflight fails closed when a fast gate is red", async () => {
  await writeMarker(HEAD);
  const result = run(["preflight"], { MOCK_FAIL_GATE: "check:architecture" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preflight gate failed: npm run check:architecture/u);
  assert.doesNotMatch(result.stdout, /Deploy preflight passed/u);
  // Fail-closed: tsc after the failed gate never ran.
  const log = await readLog();
  assert.doesNotMatch(log, /npx tsc/u);
});

test("preflight fails closed when tsc is red", async () => {
  await writeMarker(HEAD);
  const result = run(["preflight"], { MOCK_TSC_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preflight gate failed: tsc --noEmit/u);
  assert.doesNotMatch(result.stdout, /Deploy preflight passed/u);
});

test("preflight fails closed when the battery-green marker is missing", async () => {
  // No marker written.
  const result = run(["preflight"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no recorded battery-green marker/u);
  assert.doesNotMatch(result.stdout, /Deploy preflight passed/u);
});

test("preflight fails closed when the battery-green marker is stale (different HEAD)", async () => {
  await writeMarker(OTHER_HEAD);
  const result = run(["preflight"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /battery-green marker .* is STALE/u);
  assert.doesNotMatch(result.stdout, /Deploy preflight passed/u);
});

test("preflight fails closed on uncommitted changes outside the owner-dirt allowlist", async () => {
  await writeMarker(HEAD);
  const result = run(["preflight"], { MOCK_GIT_STATUS: "?? scripts/rogue.mjs\n" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the known owner-dirt allowlist/u);
  assert.doesNotMatch(result.stdout, /Deploy preflight passed/u);
});

test("preflight allows non-owner-dirt only under an explicit BP_ALLOW_DIRTY override (loud)", async () => {
  await writeMarker(HEAD);
  const result = run(["preflight"], { MOCK_GIT_STATUS: "?? scripts/rogue.mjs\n", BP_ALLOW_DIRTY: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /BP_ALLOW_DIRTY=1/u);
  assert.match(result.stdout, /Deploy preflight passed/u);
});

test("preflight allows known owner-dirt (.gitignore + perf baseline) with a loud warning", async () => {
  await writeMarker(HEAD);
  const result = run(["preflight"], { MOCK_GIT_STATUS: " M .gitignore\n?? perf/private-gateway-baseline.json\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /known owner-dirt/u);
  assert.match(result.stdout, /Deploy preflight passed/u);
});

// ---- publish auto-invoke ----

test("publish auto-invokes preflight and fails closed before any build when a gate is red", async () => {
  await writeMarker(HEAD);
  const result = run(["publish"], { MOCK_FAIL_GATE: "check:architecture" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to publish/u);
  const log = await readLog();
  // The gate ran; the build never did.
  assert.doesNotMatch(log, /docker build/u);
  assert.doesNotMatch(log, /^aws ecr /mu);
});

test("publish auto-invokes preflight and proceeds to build when all gates are green", async () => {
  await writeMarker(HEAD);
  const result = run(["publish"]);
  assert.equal(result.status, 0, result.stderr);
  const log = await readLog();
  assert.match(log, /docker build --platform linux\/amd64/u);
  assert.match(result.stdout, new RegExp(`beaver-app@${DIGEST}`, "u"));
});

test("BP_SKIP_PREFLIGHT=1 bypasses the gate loudly and still builds", async () => {
  // No marker + a red gate would normally block; the escape hatch skips the whole preflight.
  const result = run(["publish"], { BP_SKIP_PREFLIGHT: "1", MOCK_FAIL_GATE: "check:architecture" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /BP_SKIP_PREFLIGHT=1/u);
  const log = await readLog();
  assert.match(log, /docker build --platform linux\/amd64/u);
  // Skipped: no gate ran.
  assert.doesNotMatch(log, /npm run check:architecture/u);
});
