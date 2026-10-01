// promote-first-admin.mjs — give the first root admin the `admin` role.
//
// The ROOT_ADMIN_EMAIL bootstrap promotes a user to root at login by setting is_root_admin, but
// registration created the row as a `member`, and parts of the app (the /admin page's own
// check, company-admin features) key on role. deploy-aws.sh runs this once, after the owner has
// registered and logged in, as a one-off task on the migrator task definition.
//
// It touches exactly one row and only one that is ALREADY root — it never creates or elevates
// anyone the login bootstrap did not.
import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";

const email = process.env.BP_EMAIL;
if (!email) throw new Error("BP_EMAIL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: databaseTlsOptions(), max: 1 });
try {
  const result = await pool.query(
    "UPDATE users SET role = 'admin', can_run_models = true WHERE lower(email) = lower($1) AND is_root_admin = true RETURNING id",
    [email],
  );
  if (result.rowCount !== 1) {
    console.error(`[promote-first-admin] no root-admin row for ${email}: register and log in once first`);
    process.exit(3);
  }
  console.log(`[promote-first-admin] user ${result.rows[0].id} is now a root admin with the admin role`);
} finally {
  await pool.end();
}
