// [refactor jul23 P5.1-γ] Pin the round-trip between the marker WRITER (record-battery-green.sh)
// and the marker ASSERTER (deploy.sh preflight): a marker written by the real writer must be
// accepted by preflight at the same HEAD and rejected as stale at a different HEAD. This guards
// against silent format drift between the two scripts that share scripts/lib/deploy-state.sh.
// All hermetic: git/npm/npx PATH stubs; the marker file is real.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
let fixtureDir;
let markerPath;

const mockGit = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-C" ]; then shift 2; fi
case "\${1:-} \${2:-}" in
  "rev-parse HEAD") echo "\${MOCK_HEAD:-${HEAD}}" ;;
  "status --porcelain") printf '%s' "\${MOCK_GIT_STATUS:-}" ;;
  *) echo "unexpected git call: $*" >&2; exit 97 ;;
esac
`;

const mockNpm = `#!/usr/bin/env bash
set -euo pipefail
exit 0
`;

const mockNpx = `#!/usr/bin/env bash
set -euo pipefail
exit 0
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-record-battery-"));
  markerPath = path.join(fixtureDir, "battery-green.json");
  const stubs = { git: mockGit, npm: mockNpm, npx: mockNpx };
  await Promise.all(Object.entries(stubs).map(([name, body]) => writeFile(path.join(fixtureDir, name), body)));
  await Promise.all(Object.keys(stubs).map((name) => chmod(path.join(fixtureDir, name), 0o755)));
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(markerPath, { force: true });
});

function baseEnv(extraEnv = {}) {
  return {
    ...process.env,
    PATH: `${fixtureDir}:${process.env.PATH}`,
    BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
    BP_BATTERY_GREEN_FILE: markerPath,
    ...extraEnv,
  };
}

function record(extraEnv = {}) {
  return spawnSync("bash", ["scripts/record-battery-green.sh"], {
    cwd: process.cwd(), encoding: "utf8", env: baseEnv(extraEnv),
  });
}

function preflight(extraEnv = {}) {
  return spawnSync("bash", ["deploy.sh", "preflight"], {
    cwd: process.cwd(), encoding: "utf8", env: baseEnv(extraEnv),
  });
}

test("the writer records a well-formed HEAD-pinned marker", async () => {
  const result = record();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Recorded battery-green marker at HEAD ${HEAD}`, "u"));
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.version, 1);
  assert.equal(marker.head, HEAD);
  assert.deepEqual(marker.battery, ["vitest", "build"]);
  assert.equal(typeof marker.recordedAtEpoch, "number");
});

test("preflight accepts a marker written by the real writer at the same HEAD", async () => {
  const recorded = record();
  assert.equal(recorded.status, 0, recorded.stderr);
  const result = preflight();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deploy preflight passed/u);
});

test("preflight rejects the writer's marker as stale once HEAD moves", async () => {
  const recorded = record({ MOCK_HEAD: HEAD });
  assert.equal(recorded.status, 0, recorded.stderr);
  const result = preflight({ MOCK_HEAD: OTHER_HEAD });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /battery-green marker .* is STALE/u);
});

test("the writer rejects extra arguments (usage, exit 64)", () => {
  const result = record({}, );
  // sanity: no-arg form works (covered above); here assert the arg guard.
  const withArg = spawnSync("bash", ["scripts/record-battery-green.sh", "extra"], {
    cwd: process.cwd(), encoding: "utf8", env: baseEnv(),
  });
  assert.equal(withArg.status, 64);
  assert.match(withArg.stderr, /Usage:/u);
  assert.equal(result.status, 0, result.stderr);
});
