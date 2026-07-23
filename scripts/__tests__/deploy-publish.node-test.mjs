// [refactor jul23 P5.1-α] FREEZE (test-only): pin the current P2 `deploy.sh publish`
// contract and the exact usage/exit-64 dispatch matrix before any P5 addition, so every
// later P5 change (β ledger, γ preflight, δ health poll) is provably additive. No deploy.sh
// change lands in this stage. Verification is the sanctioned hermetic mock: an `aws` stub via
// PATH (never a real call) plus a `docker` stub, driven through the real script by spawnSync —
// the same dry-lint mechanism as deploy-activate.node-test.mjs / deploy-yolo.node-test.mjs.
//
// Forward-compatibility with γ: the publish happy-path invocation sets BP_SKIP_PREFLIGHT=1.
// Today deploy.sh ignores it (no preflight exists yet), so the freeze pins current behavior;
// once γ auto-invokes preflight at the top of publish, the same flag keeps this freeze pinned
// to the build/push/digest core rather than the (separately tested) gate.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIGEST = `sha256:${"a".repeat(64)}`;
let fixtureDir;
let logPath;

// Minimal AWS stub for the publish path only: caller identity, the ECR tag reuse probe
// (fails "not found" unless MOCK_TAG_EXISTS=1), the ECR login token, and the post-push digest
// resolution. Anything else is an explicit unexpected-call failure so drift is caught loudly.
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
    # The digest-resolution call carries --query imageDetails[0].imageDigest; the reuse
    # probe does not. Distinguish on that so the probe can report "absent" while resolution
    # returns the pinned digest.
    if [[ "$*" == *imageDigest* ]]; then
      echo "\${MOCK_IMAGE_DIGEST:-${DIGEST}}"
    elif [ "\${MOCK_TAG_EXISTS:-0}" = 1 ]; then
      exit 0
    else
      exit 255
    fi
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
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-deploy-publish-"));
  logPath = path.join(fixtureDir, "commands.log");
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

function baseEnv(extraEnv = {}) {
  return {
    ...process.env,
    PATH: `${fixtureDir}:${process.env.PATH}`,
    MOCK_COMMAND_LOG: logPath,
    BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
    BP_IMAGE_TAG: "deploy-freeze-test",
    // Isolate the publish freeze from γ's future auto-preflight (ignored pre-γ).
    BP_SKIP_PREFLIGHT: "1",
    // Keep β's future append-only ledger inside the fixture (ignored pre-β).
    BP_DEPLOY_LEDGER_FILE: path.join(fixtureDir, "deploy-ledger.jsonl"),
    AWS_ACCOUNT: "123456789012",
    AWS_REGION: "us-east-1",
    ECR_REPO: "beaver-app",
    ...extraEnv,
  };
}

async function publish(extraEnv = {}) {
  await writeFile(logPath, "");
  const result = spawnSync("bash", ["deploy.sh", "publish"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: baseEnv(extraEnv),
  });
  return { ...result, log: await readFile(logPath, "utf8") };
}

function run(args, extraEnv = {}) {
  return spawnSync("bash", ["deploy.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: baseEnv(extraEnv),
  });
}

// ---- publish core (immutable-digest P2 contract) ----

test("publish builds linux/amd64, pushes one immutable tag, and prints its resolved digest", async () => {
  const result = await publish();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /docker build --platform linux\/amd64/u);
  assert.match(result.log, /beaver-app:deploy-freeze-test/u);
  assert.match(result.log, /^docker push /mu);
  // Immutability invariant: publish never produces or references a :latest alias.
  assert.doesNotMatch(result.log, /:latest/u);
  assert.match(
    result.stdout,
    new RegExp(`123456789012\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/beaver-app@${DIGEST}`, "u"),
  );
  assert.match(result.stdout, /Published immutable application image/u);
  // Guidance steers to the witness cohort, never to a mutating activate for a new digest.
  assert.match(result.stdout, /preflight-outage/u);
  assert.match(result.stdout, /bind-quiescent/u);
  assert.match(result.stdout, /verify-restored/u);
});

test("publish rejects a substituted AWS caller before touching ECR or Docker", async () => {
  const result = await publish({ MOCK_CALLER_ACCOUNT: "999999999999" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS caller account identity/u);
  assert.doesNotMatch(result.log, /^(?:aws ecr|docker) /mu);
});

test("publish refuses to reuse an existing immutable tag before any build", async () => {
  const result = await publish({ MOCK_TAG_EXISTS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to reuse/u);
  assert.doesNotMatch(result.log, /^docker /mu);
});

test("publish fails closed when ECR does not return an exact sha256 digest", async () => {
  const result = await publish({ MOCK_IMAGE_DIGEST: "sha256:not-a-digest" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected an exact sha256 image digest/u);
  // The failure is post-push, proving the digest gate is the last word, not the push.
  assert.match(result.log, /^docker push /mu);
});

test("publish rejects a non-canonical ECR repository before any AWS or Docker call", async () => {
  const result = await publish({ ECR_REPO: "not-beaver-app" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ECR_REPO must be the canonical beaver-app repository/u);
  assert.doesNotMatch(result.log, /^(?:aws ecr|docker) /mu);
});

// ---- usage / exit-64 dispatch matrix (arg-count + unknown-subcommand contract) ----

for (const [name, args] of [
  ["no subcommand", []],
  ["unknown subcommand", ["bogus"]],
  ["publish with an extra argument", ["publish", "extra"]],
  ["activate without a digest", ["activate"]],
  ["activate with an extra argument", ["activate", DIGEST, "extra"]],
  ["preflight-outage with too few arguments", ["preflight-outage", DIGEST]],
  ["bind-quiescent without a digest", ["bind-quiescent"]],
  ["verify-restored with an extra argument", ["verify-restored", DIGEST, "extra"]],
]) {
  test(`usage exits 64 for ${name}`, () => {
    const result = run(args);
    assert.equal(result.status, 64, `${name} expected exit 64, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /Usage:/u);
    // usage() must fire before any AWS/Docker side effect.
    assert.doesNotMatch(result.stderr, /^(?:aws|docker) /mu);
  });
}
