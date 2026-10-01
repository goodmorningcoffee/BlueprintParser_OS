// bootstrap-first-company.mjs — the one row a fresh deployment cannot create for itself.
//
// Registration requires a company access key, and a new database has no companies, so the first
// account has nowhere to register. deploy-aws.sh runs this ONCE as a one-off ECS task on the
// migrator task definition (`./entrypoint.sh worker node scripts/bootstrap-first-company.mjs`),
// which carries DATABASE_URL and no other permission; `worker` mode has already asserted the
// schema is current. After this, the owner registers at /register with the printed key.
//
// Idempotent: refuses to add a second company. Values arrive as environment overrides on the
// task, never as argv.
import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";

const name = process.env.BP_COMPANY_NAME;
const dataKey = process.env.BP_DATA_KEY;
const accessKey = process.env.BP_ACCESS_KEY;
if (!name || !dataKey || !accessKey) {
  throw new Error("BP_COMPANY_NAME, BP_DATA_KEY and BP_ACCESS_KEY are required");
}
if (!/^[a-z0-9-]+$/u.test(dataKey)) {
  throw new Error("BP_DATA_KEY must be a lowercase slug (it becomes the company's S3 prefix)");
}
if (accessKey.length < 32 || accessKey.startsWith("$2")) {
  throw new Error("BP_ACCESS_KEY must be at least 32 characters of plain text");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: databaseTlsOptions(), max: 1 });
try {
  const existing = await pool.query("SELECT count(*)::int AS n FROM companies");
  if (existing.rows[0].n > 0) {
    // Distinct exit code: the caller must NOT show the key it generated for this run, since no
    // row carries it. Exit 4 = "already bootstrapped".
    console.log(`[bootstrap-company] ${existing.rows[0].n} company row(s) already exist; nothing inserted`);
    process.exit(4);
  }
  const inserted = await pool.query(
    "INSERT INTO companies (name, data_key, access_key, email_domain) VALUES ($1, $2, $3, '') RETURNING id",
    [name, dataKey, accessKey],
  );
  console.log(`[bootstrap-company] created company ${inserted.rows[0].id} (${dataKey})`);
} finally {
  await pool.end();
}
