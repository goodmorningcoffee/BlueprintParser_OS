import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";
import {
  MIGRATIONS_FOLDER,
  appliedMigrationContract,
  assertEmptyDatabaseBootstrapStart,
  assertLegacyLabelingRowsRetired,
  assertLegacyStorageNamespaces,
  assertP2LocalMigrationContract,
  assertP2CutoverStart,
  assertSchemaCurrent,
  localMigrationContract,
} from "./schema-migration-contract.mjs";

const P2_MODE = "p2-0037-singleton-quiescent";
const EMPTY_BOOTSTRAP_MODE = "empty-database-singleton-quiescent";
const ADVISORY_LOCK_ID = 72_420_370_038;

const migrationMode = process.env.BP_SCHEMA_MIGRATION_MODE;
if (![P2_MODE, EMPTY_BOOTSTRAP_MODE].includes(migrationMode)) {
  throw new Error(
    `Refusing database migration without an explicit singleton mode (${P2_MODE} or ${EMPTY_BOOTSTRAP_MODE})`,
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the singleton migration");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseTlsOptions(),
  max: 1,
});

const client = await pool.connect();
let lockHeld = false;
try {
  // Ignore any URL/session option that tries to redirect unqualified migration
  // objects into another schema. Drizzle's migration SQL creates application
  // objects without schema qualification.
  // With pg_catalog omitted, PostgreSQL implicitly searches it before public
  // while still using public as the creation target for unqualified DDL.
  await client.query("SET search_path = public");
  const lock = await client.query(
    "SELECT pg_catalog.pg_try_advisory_lock($1) AS acquired",
    [ADVISORY_LOCK_ID],
  );
  if (lock.rows[0]?.acquired !== true) {
    throw new Error(
      "Another schema migrator holds the advisory lock; refusing to wait and migrate later",
    );
  }
  lockHeld = true;
  await client.query("SET lock_timeout = '30s'");
  await client.query("SET statement_timeout = '8min'");
  await client.query("SET idle_in_transaction_session_timeout = '9min'");

  const local = localMigrationContract();
  assertP2LocalMigrationContract(local);
  const before = await appliedMigrationContract(client);
  if (migrationMode === EMPTY_BOOTSTRAP_MODE) {
    await assertEmptyDatabaseBootstrapStart(client, local, before);
  } else {
    assertP2CutoverStart(local, before);
    await assertLegacyStorageNamespaces(client);
    await assertLegacyLabelingRowsRetired(client, local, before);
  }

  const beforeLatest = before.at(-1);
  if (
    beforeLatest?.when === local.latest.when &&
    beforeLatest.hash === local.latest.hash
  ) {
    console.log(`[schema-migrate] already current at ${local.latest.tag}`);
  } else {
    console.log(
      `[schema-migrate] applying ${migrationMode} through ${local.latest.tag}`,
    );
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  }

  const after = await appliedMigrationContract(client);
  assertSchemaCurrent(local, after);
  console.log(`[schema-migrate] complete at ${local.latest.tag}`);
} finally {
  if (lockHeld) {
    await client
      .query("SELECT pg_catalog.pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
  }
  client.release();
  await pool.end();
}
