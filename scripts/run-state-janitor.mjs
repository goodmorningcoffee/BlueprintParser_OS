// [refactor jul23 P5.4-E] Standalone advisory-locked TTL janitor for the
// PG-backed runtime state tables (runtime_counters / login_lockouts /
// manual_ip_bans auto-bans / op_log). Runs as `entrypoint.sh janitor`, invoked
// on a schedule (e.g. an ECS scheduled task). One-shot: acquire a non-blocking
// pg_try_advisory_lock so concurrent janitors across an N-task cluster never
// stampede — a loser simply exits 0. Owner-operated against real DBs only;
// agents exercise the sweep exclusively through the vitest fake-db freeze.
//
// The four sweep statements MUST stay byte-identical to the canonical, vitest-
// frozen copy in src/lib/runtime-state-janitor.ts (raw-node entrypoint scripts
// cannot import compiled TS, hence the deliberate mirror).
import { Pool } from "pg";
import { databaseTlsOptions } from "./database-tls.mjs";

const ADVISORY_LOCK_ID = 72_420_390_039;
const OP_LOG_RETENTION = 500;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the runtime-state janitor");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseTlsOptions(),
  max: 1,
});

const client = await pool.connect();
let lockHeld = false;
try {
  await client.query("SET search_path = public");
  const lock = await client.query(
    "SELECT pg_catalog.pg_try_advisory_lock($1) AS acquired",
    [ADVISORY_LOCK_ID],
  );
  if (lock.rows[0]?.acquired !== true) {
    console.log("[state-janitor] another janitor holds the lock; skipping");
  } else {
    lockHeld = true;
    await client.query("SET lock_timeout = '30s'");
    await client.query("SET statement_timeout = '2min'");

    const runtimeCounters = await client.query(
      "DELETE FROM runtime_counters WHERE reset_at < now()",
    );
    const loginLockouts = await client.query(
      "DELETE FROM login_lockouts WHERE last_attempt < now() - interval '2 hours'",
    );
    const autoBans = await client.query(
      "DELETE FROM manual_ip_bans WHERE source = 'auto' AND banned_until IS NOT NULL AND banned_until < now()",
    );
    const opLog = await client.query(
      "DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY created_at DESC, id DESC LIMIT $1)",
      [OP_LOG_RETENTION],
    );
    console.log(
      `[state-janitor] swept runtime_counters=${runtimeCounters.rowCount ?? 0} ` +
        `login_lockouts=${loginLockouts.rowCount ?? 0} ` +
        `auto_bans=${autoBans.rowCount ?? 0} op_log=${opLog.rowCount ?? 0}`,
    );
  }
} finally {
  if (lockHeld) {
    await client
      .query("SELECT pg_catalog.pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
  }
  client.release();
  await pool.end();
}
