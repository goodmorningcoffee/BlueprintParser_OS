#!/usr/bin/env node
import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";
import {
  assertEmptyDatabaseBootstrapStart,
  assertStrictEmptyDatabaseBootstrapStart,
  assertLegacyLabelingRowsRetired,
  assertLegacyStorageNamespaces,
  assertP2CutoverStart,
  assertP2LocalMigrationContract,
  appliedMigrationContract,
  localMigrationContract,
} from "./schema-migration-contract.mjs";

const P2_MODE = "p2-0037-singleton-quiescent";
const EMPTY_BOOTSTRAP_STRICT_MODE = "empty-database-strict-readiness";
const EMPTY_BOOTSTRAP_RETRY_MODE = "empty-database-armed-retry-readiness";
const ADVISORY_LOCK_ID = 72_420_370_038;

const readinessMode = process.argv[2];
if (
  ![
    P2_MODE,
    EMPTY_BOOTSTRAP_STRICT_MODE,
    EMPTY_BOOTSTRAP_RETRY_MODE,
  ].includes(readinessMode)
) {
  throw new Error(
    `Refusing schema readiness without an explicit mode (${P2_MODE}, ${EMPTY_BOOTSTRAP_STRICT_MODE}, or ${EMPTY_BOOTSTRAP_RETRY_MODE})`,
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for schema readiness");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseTlsOptions(),
  max: 1,
});

const client = await pool.connect();
let lockHeld = false;
let transactionOpen = false;
try {
  // Omit pg_catalog so PostgreSQL searches it implicitly before public while
  // retaining public as the only unqualified object-creation target.
  await client.query("SET search_path = public");
  const lock = await client.query(
    "SELECT pg_catalog.pg_try_advisory_lock($1) AS acquired",
    [ADVISORY_LOCK_ID],
  );
  if (lock.rows[0]?.acquired !== true) {
    throw new Error(
      "Another schema migrator holds the advisory lock; readiness is not stable",
    );
  }
  lockHeld = true;

  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  transactionOpen = true;
  await client.query("SET LOCAL statement_timeout = '2min'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '3min'");

  const local = localMigrationContract();
  assertP2LocalMigrationContract(local);
  const applied = await appliedMigrationContract(client);
  if (readinessMode === EMPTY_BOOTSTRAP_STRICT_MODE) {
    await assertStrictEmptyDatabaseBootstrapStart(client, local, applied);
  } else if (readinessMode === EMPTY_BOOTSTRAP_RETRY_MODE) {
    await assertEmptyDatabaseBootstrapStart(client, local, applied);
  } else {
    assertP2CutoverStart(local, applied);
    await assertLegacyStorageNamespaces(client);
    await assertLegacyLabelingRowsRetired(client, local, applied);
  }

  await client.query("COMMIT");
  transactionOpen = false;
  console.log(`[schema-readiness] ${readinessMode} passed`);
} finally {
  if (transactionOpen) {
    await client.query("ROLLBACK").catch(() => undefined);
  }
  if (lockHeld) {
    await client
      .query("SELECT pg_catalog.pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
  }
  client.release();
  await pool.end();
}
