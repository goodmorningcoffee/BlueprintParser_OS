// [refactor jul23 P5.3 U1] Freeze test locking the cost-control.sh "double bug" fix as a
// REMOVAL. The original scripts/cost-control.sh carried two cost kill-switches (SageMaker +
// Step Functions) that BOTH no-op'd — each for a compounded reason (wrong role *type* AND
// wrong `blueprintparser-*` name *prefix* vs the canonical `beaver-*`). The P2/P5 closure
// (9b69d41) removed both toggles and rewrote the script to a READ-ONLY report that hard-asserts
// canonical names. This test locks that state so the toggles cannot silently return:
//   (a) non-canonical ECS names fail closed (bp_die) BEFORE any aws call, and
//   (b) the source contains no IAM/service *mutation* verb.
// It also pins the canonical `beaver-*` names so a naming regression is caught.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const scriptPath = path.join(repoRoot, "scripts", "cost-control.sh");

test("non-canonical ECS_CLUSTER fails closed without invoking AWS", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "bp-cost-control-test-"));
  const marker = path.join(fakeBin, "aws-was-called");
  const fakeAws = path.join(fakeBin, "aws");
  await writeFile(
    fakeAws,
    `#!/usr/bin/env bash
printf 'called' > "${marker}"
exit 0
`,
  );
  await chmod(fakeAws, 0o755);

  const result = spawnSync("bash", [scriptPath, "status"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      // Point at a nonexistent env file so a local (gitignored) .deploy.env can't leak in.
      BP_DEPLOY_ENV_FILE: path.join(fakeBin, "no-such-deploy.env"),
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECS_CLUSTER: "blueprintparser-cluster", // legacy name → must be rejected
      ECS_SERVICE: "blueprintparser-app",
    },
    encoding: "utf8",
  });

  // bp_die returns 1 under `set -e`; the canonical assert fires before bp_assert_caller_account.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ECS_CLUSTER must be beaver-cluster/);
  // The canonical assert runs before the first aws call, so the fake `aws` is never invoked.
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("non-canonical ECS_SERVICE fails closed without invoking AWS", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "bp-cost-control-test-"));
  const marker = path.join(fakeBin, "aws-was-called");
  const fakeAws = path.join(fakeBin, "aws");
  await writeFile(
    fakeAws,
    `#!/usr/bin/env bash
printf 'called' > "${marker}"
exit 0
`,
  );
  await chmod(fakeAws, 0o755);

  const result = spawnSync("bash", [scriptPath, "status"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      BP_DEPLOY_ENV_FILE: path.join(fakeBin, "no-such-deploy.env"),
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECS_CLUSTER: "beaver-cluster", // canonical cluster, non-canonical service
      ECS_SERVICE: "blueprintparser-app",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ECS_SERVICE must be beaver-app/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("cost-control.sh is a read-only report — no IAM/service mutation verbs, canonical names pinned", async () => {
  const source = await readFile(scriptPath, "utf8");
  const executableLines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  // The removed kill-switches were IAM/service mutations. None of these verbs may reappear.
  const mutationVerbs = [
    "put-role-policy",
    "delete-role-policy",
    "attach-role-policy",
    "put-user-policy",
    "update-service",
    "put-scaling-policy",
    "register-task-definition",
    "put-image-scanning-configuration",
    "set-desired-capacity",
    "--desired-count",
    "--min-capacity",
  ];
  for (const verb of mutationVerbs) {
    const offending = executableLines.find((line) => line.includes(verb));
    assert.equal(
      offending,
      undefined,
      `cost-control.sh must stay read-only but an executable line contains "${verb}": ${offending}`,
    );
  }

  // Canonicalization is locked: the report asserts the beaver-* cluster/service.
  assert.match(source, /beaver-cluster/);
  assert.match(source, /beaver-app/);
});
