import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";
import {
  appliedMigrationContract,
  assertSchemaCurrent,
  localMigrationContract,
} from "./schema-migration-contract.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the schema contract check");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseTlsOptions(),
  max: 1,
});

try {
  const client = await pool.connect();
  try {
    const local = localMigrationContract();
    const applied = await appliedMigrationContract(client);
    assertSchemaCurrent(local, applied);
    console.log(`[schema-check] current at ${local.latest.tag}`);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
