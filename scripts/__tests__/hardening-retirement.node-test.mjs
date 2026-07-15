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
const hardeningPath = path.join(repoRoot, "hardening.sh");

test("retired hardening entrypoint fails closed without invoking AWS", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "bp-hardening-test-"));
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

  const result = spawnSync("bash", [hardeningPath, "someone@example.test"], {
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
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("retirement source contains no executable AWS invocation", async () => {
  const source = await readFile(hardeningPath, "utf8");
  const executableLines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.equal(
    executableLines.some((line) => /(^|[;&|()])\s*aws(?:\s|$)/u.test(line)),
    false,
  );
  assert.match(source, /must never try to repair them/);
  assert.match(source, /exit 64/);
});
