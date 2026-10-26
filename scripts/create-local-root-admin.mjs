#!/usr/bin/env node
import { assertLocalSchemaMutationTarget } from "./run-local-drizzle-command.mjs";

async function main() {
  // This is a write-capable setup boundary, not merely a migration follow-up.
  // Refuse before loading pg so a remote/cloud target cannot reach Pool at all.
  assertLocalSchemaMutationTarget();

  // [2026-10-25] Sign-in lowercases the address; a mixed-case row could never log in.
  const email = process.env.SETUP_EMAIL?.trim().toLowerCase();
  const username = process.env.SETUP_USER;
  const password = process.env.SETUP_PASS;
  if (!email || !username || !password) {
    throw new Error("SETUP_EMAIL, SETUP_USER, and SETUP_PASS are required");
  }

  const [{ default: bcrypt }, { randomBytes }, { Pool }] = await Promise.all([
    import("bcrypt"),
    import("node:crypto"),
    import("pg"),
  ]);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const hash = await bcrypt.hash(password, 12);
    const existing = await pool.query("SELECT id FROM companies LIMIT 1");
    let companyId = existing.rows[0]?.id;
    if (!companyId) {
      const accessKey = randomBytes(24).toString("hex");
      const company = await pool.query(
        "INSERT INTO companies (name, data_key, access_key, email_domain) VALUES ('Default', 'default', $1, 'local.invalid') RETURNING id",
        [accessKey],
      );
      companyId = company.rows[0].id;
    }

    // [2026-10-25] An existing user is never silently overwritten (password reset + root grant)
    // unless the operator says so with SETUP_FORCE=1.
    const force = process.env.SETUP_FORCE === "1";
    const result = await pool.query(
      force
        ? "INSERT INTO users (email, username, password_hash, role, is_root_admin, company_id) VALUES ($1, $2, $3, 'admin', true, $4) ON CONFLICT (email) DO UPDATE SET is_root_admin = true, password_hash = $3, role = 'admin'"
        : "INSERT INTO users (email, username, password_hash, role, is_root_admin, company_id) VALUES ($1, $2, $3, 'admin', true, $4) ON CONFLICT (email) DO NOTHING",
      [email, username, hash, companyId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`a user with email ${email} already exists; re-run with SETUP_FORCE=1 to reset its password and make it root`);
    }
    console.log(`  Root admin ${force ? "created or updated" : "created"}: ${email}`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[local-admin] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
