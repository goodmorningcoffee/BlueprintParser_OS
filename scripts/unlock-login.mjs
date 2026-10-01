// unlock-login.mjs — clear every login lockout for one account.
//
// The ladder is keyed email|ip and an account-wide ceiling refuses the account for an hour after
// 50 failures from any addresses. That ceiling can be reached on purpose by a few addresses, and
// the correct password is refused while it stands. deploy-aws.sh `unlock-login <email>` runs this
// as a one-off task on the migrator task definition (DATABASE_URL, nothing else).
import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";

const email = (process.env.BP_EMAIL || "").toLowerCase();
if (!email) throw new Error("BP_EMAIL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: databaseTlsOptions(), max: 1 });
try {
  const ladder = await pool.query("DELETE FROM login_lockouts WHERE email = $1 OR email LIKE $2", [email, `${email}|%`]);
  const ceiling = await pool.query("DELETE FROM runtime_counters WHERE scope = 'login_fail_email' AND key = $1", [email]);
  console.log(`[unlock-login] ${email}: ${ladder.rowCount} ladder row(s), ${ceiling.rowCount} ceiling row(s) cleared`);
} finally {
  await pool.end();
}
