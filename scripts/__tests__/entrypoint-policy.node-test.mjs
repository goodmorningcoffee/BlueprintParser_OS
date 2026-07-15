import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let fixtureDir;
let commandLog;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-entrypoint-policy-"));
  commandLog = path.join(fixtureDir, "commands.log");
  const mockNode = path.join(fixtureDir, "node");
  await writeFile(
    mockNode,
    `#!/bin/sh
set -eu
printf 'node' >> "\${MOCK_COMMAND_LOG}"
for argument in "$@"; do
  printf '\\t%s' "\${argument}" >> "\${MOCK_COMMAND_LOG}"
done
printf '\\n' >> "\${MOCK_COMMAND_LOG}"
if [ "\${1:-}" = "scripts/assert-schema-current.mjs" ] &&
   [ "\${MOCK_SCHEMA_CHECK_EXIT:-0}" != "0" ]; then
  exit "\${MOCK_SCHEMA_CHECK_EXIT}"
fi
`,
  );
  await chmod(mockNode, 0o755);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function runEntrypoint(args, extraEnv = {}) {
  await writeFile(commandLog, "");
  const result = spawnSync("sh", ["entrypoint.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      MOCK_COMMAND_LOG: commandLog,
      ...extraEnv,
    },
  });
  return { ...result, commands: await readFile(commandLog, "utf8") };
}

test("entrypoint contains no project SQL or DML authority", async () => {
  const source = await readFile("entrypoint.sh", "utf8");
  assert.doesNotMatch(source, /\bprojects?\b/iu);
  assert.doesNotMatch(
    source,
    /\b(?:select|insert|update|delete|merge|truncate)\b/iu,
  );
  assert.doesNotMatch(source, /\b(?:Pool|query)\b|require\(["']pg["']\)/u);
});

for (const args of [[], ["app"]]) {
  test(`app mode ${args.length === 0 ? "default" : "explicit"} checks schema then execs only the server`, async () => {
    const result = await runEntrypoint(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.commands,
      "node\tscripts/assert-schema-current.mjs\nnode\tserver.js\n",
    );
    assert.match(result.stdout, /^Starting application\.\.\.$/mu);
  });
}

test("schema modes execute only their exact authority command", async () => {
  const cases = [
    {
      args: ["schema-check"],
      expected: "node\tscripts/assert-schema-current.mjs\n",
    },
    {
      args: ["schema-readiness", "p2-0037-singleton-quiescent"],
      expected:
        "node\tscripts/assert-schema-migration-ready.mjs\tp2-0037-singleton-quiescent\n",
    },
    {
      args: ["migrate"],
      expected: "node\tscripts/run-schema-migrations.mjs\n",
    },
  ];
  for (const { args, expected } of cases) {
    const result = await runEntrypoint(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.commands, expected);
    assert.doesNotMatch(result.stdout, /Starting application/u);
  }
});

test("worker mode checks schema before executing only the supplied command", async () => {
  const result = await runEntrypoint(["worker", "node", "worker.js", "--once"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.commands,
    "node\tscripts/assert-schema-current.mjs\nnode\tworker.js\t--once\n",
  );
  assert.doesNotMatch(result.stdout, /Starting application/u);
});

test("failed schema admission prevents app and worker execution", async () => {
  for (const args of [[], ["worker", "node", "worker.js"]]) {
    const result = await runEntrypoint(args, { MOCK_SCHEMA_CHECK_EXIT: "23" });
    assert.equal(result.status, 23);
    assert.equal(result.commands, "node\tscripts/assert-schema-current.mjs\n");
    assert.doesNotMatch(result.stdout, /Starting application/u);
  }
});

test("unknown and empty-worker modes fail without executing a command", async () => {
  for (const args of [["unknown"], ["worker"]]) {
    const result = await runEntrypoint(args);
    assert.equal(result.status, 64);
    assert.equal(result.commands, "");
    assert.match(result.stderr, /^ERROR:/mu);
  }
});
