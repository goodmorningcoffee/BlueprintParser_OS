import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIGEST = `sha256:${"a".repeat(64)}`;
let fixtureDir;
let logPath;

const mockAws = `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\n' "$*" >> "\${MOCK_COMMAND_LOG}"
case "\${1:-} \${2:-}" in
  "sts get-caller-identity")
    echo "\${MOCK_CALLER_ACCOUNT:-123456789012}"
    ;;
  "ecr get-login-password")
    echo mock-password
    ;;
  "ecr describe-images")
    count=$(grep -c '^aws ecr describe-images ' "\${MOCK_COMMAND_LOG}")
    if [ "\${MOCK_TAG_EXISTS:-0}" = 1 ]; then
      echo "${DIGEST}"
    elif [ "\${count}" -eq 1 ]; then
      exit 255
    else
      echo "\${MOCK_IMAGE_DIGEST:-${DIGEST}}"
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
printf 'docker %s\n' "$*" >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = login ]; then
  read -r _password
fi
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-yolo-publish-"));
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

async function publish(extraEnv = {}) {
  await writeFile(logPath, "");
  const result = spawnSync("bash", ["deploy-yolo.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      MOCK_COMMAND_LOG: logPath,
      BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
      BP_YOLO_IMAGE_TAG: "yolo-deploy-test",
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECR_YOLO_REPO: "beaver-yolo-pipeline",
      ...extraEnv,
    },
  });
  return { ...result, log: await readFile(logPath, "utf8") };
}

test("publishes one fresh immutable YOLO tag and prints its resolved digest", async () => {
  const result = await publish();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /docker build --platform linux\/amd64/u);
  assert.match(result.log, /beaver-yolo-pipeline:yolo-deploy-test/u);
  assert.doesNotMatch(result.log, /:latest/u);
  assert.match(result.stdout, new RegExp(`beaver-yolo-pipeline@${DIGEST}`));
  assert.match(result.stdout, /TF_VAR_beaver_yolo_image_digest=/u);
});

test("rejects a substituted AWS caller before touching ECR or Docker", async () => {
  const result = await publish({ MOCK_CALLER_ACCOUNT: "999999999999" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS caller account identity/u);
  assert.doesNotMatch(result.log, /^(?:aws ecr|docker) /mu);
});

test("refuses to reuse an existing immutable tag", async () => {
  const result = await publish({ MOCK_TAG_EXISTS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to reuse/u);
  assert.doesNotMatch(result.log, /^docker /mu);
});

test("fails closed when ECR does not return an exact digest", async () => {
  const result = await publish({ MOCK_IMAGE_DIGEST: "sha256:not-a-digest" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected an exact sha256 image digest/u);
  assert.match(result.log, /^docker push /mu);
});
