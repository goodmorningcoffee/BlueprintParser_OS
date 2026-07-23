/**
 * runtime-state-janitor.ts — TTL sweep for the P5.4 PG-backed runtime state.
 *
 * [refactor jul23 P5.4-E] Replaces the per-ECS-task in-process setInterval sweeps
 * (middleware.ts / auth.ts / manual-ban-cache.ts) with a single advisory-locked
 * janitor so an N-task cluster does not stampede the sweep. The standalone
 * entrypoint runner (scripts/run-state-janitor.mjs, `entrypoint.sh janitor`)
 * holds pg_advisory_lock and calls sweepRuntimeState(); this module is the
 * canonical, vitest-frozen source of the sweep SQL (the .mjs runner mirrors it
 * verbatim because raw-node entrypoint scripts cannot import compiled TS).
 *
 * Sweep semantics deliberately mirror the in-memory sweeps they replace:
 *   - runtime_counters: drop buckets whose fixed window has closed.
 *   - login_lockouts:   drop only entries idle >2h (auth.ts:57) — the failure
 *                       count is KEPT across an expired lockout, so escalation
 *                       survives; only true inactivity clears an entry.
 *   - manual_ip_bans:   drop only EXPIRED AUTO bans (transient escalation state,
 *                       the former banStore). Manual Root_Admin rows are durable
 *                       records and are never swept here.
 *   - op_log:           retain the newest OP_LOG_RETENTION rows (the ring cap's
 *                       durable successor); trim the rest.
 */

/** Minimal node-postgres client surface the sweep needs (Pool/Client/PoolClient). */
export interface JanitorClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount: number | null }>;
}

/** Newest op_log rows to retain; older rows are swept. */
export const OP_LOG_RETENTION = 500;

export interface JanitorSweepResult {
  runtimeCounters: number;
  loginLockouts: number;
  autoBans: number;
  opLog: number;
}

export async function sweepRuntimeState(
  client: JanitorClient,
): Promise<JanitorSweepResult> {
  // Fixed-window buckets whose window has already closed.
  const runtimeCounters = await client.query(
    "DELETE FROM runtime_counters WHERE reset_at < now()",
  );
  // Only truly idle lockouts (>2h since last attempt). locked_until expiry does
  // NOT clear the row — the count must survive to keep escalating repeat offenders.
  const loginLockouts = await client.query(
    "DELETE FROM login_lockouts WHERE last_attempt < now() - interval '2 hours'",
  );
  // Expired auto-bans only; manual bans (including permanent banned_until NULL) persist.
  const autoBans = await client.query(
    "DELETE FROM manual_ip_bans WHERE source = 'auto' AND banned_until IS NOT NULL AND banned_until < now()",
  );
  // Keep the newest OP_LOG_RETENTION rows by recency.
  const opLog = await client.query(
    "DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY created_at DESC, id DESC LIMIT $1)",
    [OP_LOG_RETENTION],
  );
  return {
    runtimeCounters: runtimeCounters.rowCount ?? 0,
    loginLockouts: loginLockouts.rowCount ?? 0,
    autoBans: autoBans.rowCount ?? 0,
    opLog: opLog.rowCount ?? 0,
  };
}
