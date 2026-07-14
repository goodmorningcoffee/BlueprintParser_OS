// [refactor jun12 P0.3] vitest globalSetup — runs ONCE per suite run, before
// any worker starts. Recreates the test database schema from migrations so
// every run starts from a clean, migration-faithful state (the same DDL path
// production boots through).
//
// DB-less environments: if nothing listens on :5433 the DB-backed route tests
// SKIP (suite stays green for unit-test-only contexts) unless
// BP_REQUIRE_TEST_DB=1 (set in CI, where a postgres service is guaranteed).
// Start the local DB with: scripts/test-db.sh start
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
