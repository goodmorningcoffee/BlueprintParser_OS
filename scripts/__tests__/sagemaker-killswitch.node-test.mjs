// [refactor jul23 P5.3 U2] Regression lock for the RETIRED sagemaker-killswitch.sh.
//
// FREEZE-FIRST HISTORY (documented, no longer executable): before this retirement the
// script made a LIVE, unreviewed IAM mutation from the repo — `aws iam put-role-policy`
// / `aws iam delete-role-policy` on an ECS *task* role to add/remove a `Deny sagemaker:*`
// inline policy. That was the wrong PRINCIPAL (SageMaker jobs run under a SageMaker
// execution role, not the app's ECS task role) against a stale legacy role name
// (`blueprintparser-ecs-task-role`), so it could silently no-op while printing
// "SageMaker BLOCKED". The freeze probe that pinned this bug (run against the pre-retirement
// script under a fake `aws` on PATH) captured exactly:
//   AWS_CALLED: iam put-role-policy --role-name <role> --policy-name sagemaker-kill-switch ...
// The bug is now neutralized to the hardening.sh fail-closed tombstone pattern; a *working*
// kill switch (correct principal + canonical beaver-* names, via reviewed Terraform/IAM) is
// an OWNER follow-up. These tests assert the neutralized behavior: NO aws invocation, exit 64.
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
const scriptPath = path.join(repoRoot, "scripts", "sagemaker-killswitch.sh");

// The tombstone ignores its argument and always fails closed — exercise every legacy verb.
for (const arg of ["off", "on", "status"]) {
  test(`retired sagemaker kill switch (${arg}) fails closed without invoking AWS`, async () => {
    const fakeBin = await mkdtemp(path.join(tmpdir(), "bp-sagemaker-test-"));
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

    const result = spawnSync("bash", [scriptPath, arg], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /deliberately side-effect-free/);
    assert.match(result.stderr, /No AWS command has been run/);
    // The fake `aws` writes the marker only if invoked; its absence proves no IAM mutation.
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
}

test("retirement source contains no executable AWS invocation", async () => {
  const source = await readFile(scriptPath, "utf8");
  const executableLines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  // No executable line may invoke `aws` (comment + heredoc-prose mentions are excluded:
  // comments are stripped above; prose references `aws` only after a backtick, which this
  // command-position regex — matching aws at line start or after ;&|() — does not match).
  assert.equal(
    executableLines.some((line) => /(^|[;&|()])\s*aws(?:\s|$)/u.test(line)),
    false,
  );
  assert.match(source, /must never try to repair it/);
  assert.match(source, /exit 64/);
});
