// [refactor jun12 P0.3] vitest globalSetup — runs ONCE per suite run, before
// any worker starts. Recreates the test database schema from migrations so
// every run starts from a clean, migration-faithful state (the same DDL path
// production boots through).
//
// DB-less environments: if nothing listens on :5433 the DB-backed route tests
// SKIP (suite stays green for unit-test-only contexts) unless
// BP_REQUIRE_TEST_DB=1 (set in CI, where a postgres service is guaranteed).
// Start the local DB with: scripts/test-db.sh start
//
// CSI v2 lookup table (owner ruling D1, 2026-10-20): src/data/csi-kb.json is gitignored by
// design, so a fresh clone (GitHub CI) has none and the tests that read it SKIP. The per-file
// console.warn in those tests shows only under --reporter=verbose; globalSetup output is printed
// by the default reporter, so the skip is announced here. Under BP_REQUIRE_CSI_KB=1 (the default
// of /workspaces/projects/scripts/bp-suite, the run GREEN_HEADS records) an absent KB fails the
// whole run instead, so a recorded-green run can never be green on skips.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const TEST_DATABASE_URL =
  process.env.BP_TEST_DATABASE_URL ??
  "postgres://bp_test:bp_test@localhost:5433/bp_test";
const testDatabase = new URL(TEST_DATABASE_URL);
if (!["localhost", "127.0.0.1", "::1"].includes(testDatabase.hostname)) {
  throw new Error("BP_TEST_DATABASE_URL must target localhost");
}

export default async function setup({
  provide,
}: {
  provide: (key: string, value: unknown) => void;
}) {
  const csiKb = "src/data/csi-kb.json";
  if (!existsSync(join(process.cwd(), csiKb))) {
    const why =
      `${csiKb} is absent (gitignored by design, owner ruling D1). Rebuild it from the MasterFormat PDF — ` +
      "see the header of eval/csi/build-kb-v2.ts";
    if (process.env.BP_REQUIRE_CSI_KB === "1") {
      throw new Error(`[csi-kb] required (BP_REQUIRE_CSI_KB=1) but ${why}`);
    }
    console.warn(`[csi-kb] ${why}. The tests that read it (csi-kb-artifact, csi-kb-loader) will SKIP.`);
  }
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 1500,
    max: 2,
  });
  let up = false;
  try {
    // fresh slate: app schema AND drizzle's migration-journal schema
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    );
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    up = true;
    console.log("[test-db] schema migrated fresh");
  } catch (err) {
    if (process.env.BP_REQUIRE_TEST_DB === "1") {
      throw new Error(
        `[test-db] required but unreachable at ${TEST_DATABASE_URL} — ${String(err)}`,
      );
    }
    console.warn(
      `[test-db] unreachable (${(err as Error).message}) — DB-backed route tests will SKIP. ` +
        "Start it with: scripts/test-db.sh start",
    );
  } finally {
    await pool.end().catch(() => {});
  }
  provide("dbUp", up);
}
