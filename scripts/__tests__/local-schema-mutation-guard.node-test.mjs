import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertLocalSchemaMutationTarget } from "../run-local-drizzle-command.mjs";

const LOCAL_DATABASE_URL =
  "postgres://bp_test:bp_test@localhost:5433/blueprintparser";

test("local schema mutation guard accepts a loopback development database", () => {
  assert.doesNotThrow(() =>
    assertLocalSchemaMutationTarget({ DATABASE_URL: LOCAL_DATABASE_URL }),
  );
});

test("local schema mutation guard rejects production mode", () => {
  assert.throws(
    () =>
      assertLocalSchemaMutationTarget({
        DATABASE_URL: LOCAL_DATABASE_URL,
        NODE_ENV: "production",
      }),
    /NODE_ENV=production/u,
  );
});

test("local schema mutation guard rejects a non-loopback database", () => {
  assert.throws(
    () =>
      assertLocalSchemaMutationTarget({
        DATABASE_URL:
          "postgres://beaver:secret@production.example.com:5432/blueprintparser",
      }),
    /non-loopback/u,
  );
});

test("local schema mutation guard rejects an ECS runtime", () => {
  assert.throws(
    () =>
      assertLocalSchemaMutationTarget({
        DATABASE_URL: LOCAL_DATABASE_URL,
        ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/test",
      }),
    /cloud container/u,
  );
});

test("local schema mutation guard rejects a query-string host override", () => {
  assert.throws(
    () =>
      assertLocalSchemaMutationTarget({
        DATABASE_URL: `${LOCAL_DATABASE_URL}?host=production.example.com`,
      }),
    /target override parameter/u,
  );
});

test("database studio is routed through the executable production guard", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-local-drizzle-command.mjs", "studio"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: LOCAL_DATABASE_URL,
        NODE_ENV: "production",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NODE_ENV=production/u);
  assert.doesNotMatch(result.stderr, /Usage:/u);
});

for (const [name, env, expected] of [
  ["production", { NODE_ENV: "production" }, /NODE_ENV=production/u],
  [
    "remote",
    {
      DATABASE_URL:
        "postgres://beaver:secret@production.example.com:5432/blueprintparser",
    },
    /non-loopback/u,
  ],
]) {
  test(`local root-admin writer refuses ${name} authority before Pool`, () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/create-local-root-admin.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: LOCAL_DATABASE_URL,
          SETUP_EMAIL: "admin@local.invalid",
          SETUP_USER: "admin",
          SETUP_PASS: "not-a-real-password",
          ...env,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /ECONN|connect|Pool/u);
  });
}

test("setup and seed entrypoints retain the local-only authority fence", async () => {
  const [setup, installer, seed, localAdmin, packageJson] = await Promise.all([
    readFile("scripts/setup.sh", "utf8"),
    readFile("install_setup.sh", "utf8"),
    readFile("src/lib/db/seed.ts", "utf8"),
    readFile("scripts/create-local-root-admin.mjs", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  assert.match(setup, /set -euo pipefail/u);
  assert.match(setup, /npm run db:migrate --silent/u);
  assert.match(setup, /node scripts\/create-local-root-admin\.mjs/u);
  assert.doesNotMatch(setup, /new Pool/u);
  assert.doesNotMatch(setup, /export \$\(.*xargs/u);
  assert.match(installer, /migration_ready=0/u);
  assert.match(installer, /Skipping demo seed because schema admission did not succeed/u);
  assert.match(installer, /npm run db:seed --silent/u);
  assert.match(installer, /BP_HEALTH_DATABASE_URL="\$CFG_DATABASE_URL"/u);
  assert.doesNotMatch(installer, /connectionString:'\$\{CFG_DATABASE_URL\}'/u);
  assert.match(seed, /assertLocalSchemaMutationTarget\(\)/u);
  assert.match(seed, /finally \{/u);
  assert.match(seed, /process\.exitCode = 1/u);
  assert.ok(
    localAdmin.indexOf("assertLocalSchemaMutationTarget();") <
      localAdmin.indexOf('import("pg")'),
  );
  assert.doesNotMatch(localAdmin, /from ["']pg["']/u);
  assert.match(
    packageJson,
    /"db:seed": "node scripts\/run-local-seed\.mjs"/u,
  );
  assert.match(
    packageJson,
    /"db:studio": "node scripts\/run-local-drizzle-command\.mjs studio"/u,
  );
  assert.match(installer, /umask 077/u);
});
