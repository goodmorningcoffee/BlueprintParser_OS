/**
 * Process-local 60s TTL cache for admin Logs tab CloudWatch queries.
 *
 * Rationale: the Engagement / Visitors / Monitor subtabs each run expensive
 * CloudWatch API calls (Insights queries 2–5s each, GetMetricData / Budgets
 * ~500ms). Rapid tab-switching or double-clicking Refresh would otherwise
 * re-run them unnecessarily. A 60s TTL means a click within the cache
 * window is instant; after it, one fresh AWS call.
 *
 * Keyspace is tiny (one key per (route, range) combination — at most 9
 * entries across the whole Logs tab), so no eviction logic is needed. The
 * cache is per-ECS-task, so a 4-task cluster effectively runs 4 AWS queries
 * per 60s window instead of 1 — still a huge reduction vs uncached.
 *
 * [refactor jul9 P2-A C1] Memory-model amendment (SPEC_FINAL §1.8 (b)): the
 * "keyspace tiny, no eviction" note assumed small scalar values. The CSI
 * company-DB resolver (csi-company-db.ts) now also stores MB-scale parsed
 * databases here — one per custom-DB company, keyed `csi-db:<id>:v1`. These
 * are bounded by the I-9 caps (CSI_DB_MAX_BYTES / CSI_DB_MAX_ENTRIES) times
 * the custom-DB tenant count and are NOT swept on expiry (process-lifetime
 * resident). Accepted at the current tenant count; revisit if it grows.
 *
 * NOT to be used for data that changes based on admin actions (e.g. manual
 * bans) — those fetches stay uncached so ban/unban toggles take effect on
 * the very next refresh — UNLESS the mutating route explicitly calls
 * `invalidateCache` after the write (see csi-company-db.ts + csi-upload.ts,
 * which invalidate the company's `csi-db:` key on upload/revert).
 *
 * [refactor jul9 P2-A C1] Invalidation semantics (SPEC_FINAL §1.8 (c)):
 * same-process invalidation is IMMEDIATE and GENERATION-GUARDED — an in-flight
 * fetch of the pre-invalidation value can never reinstate a stale entry after
 * `invalidateCache` runs (see the generation token below). Cross-task
 * staleness is TTL-bounded (each ECS task has its own cache).
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Returns cached `fn()` result if fresh; otherwise runs `fn()` and caches.
 *
 * Uses a singleton promise per key to coalesce concurrent misses — if two
 * admins hit Refresh simultaneously, only one AWS call fires and both wait
 * on the same promise.
 */
const inflight = new Map<string, Promise<unknown>>();

// [refactor jul9 P2-A C1] Generation token per key (SPEC_FINAL §1.8, C1-F2(a)
// UPGRADED — see §9 R-1). `invalidateCache` bumps a key's generation while a
// fetch is in flight; the fetch captures its generation before awaiting and
// only writes to `cache` if it still matches on settle. Without this, deleting
// the inflight entry alone would NOT stop an already-running fetch of the OLD
// value from unconditionally repopulating `cache` when it resolves (the
// cache.set below runs inside the pending closure), reinstating a stale
// snapshot for a full TTL — precisely when an admin re-uploads during active
// ingest. The map only ever grows for keys that have been invalidated
// mid-flight; entries are cheap integers and disjoint from the value cache.
const generation = new Map<string, number>();

export async function cachedQuery<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.data;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  // [refactor jul9 P2-A C1] snapshot the generation BEFORE awaiting fn(); a
  // concurrent invalidateCache(prefix ⊇ key) bumps it and the settle below
  // then skips the stale cache.set.
  const myGen = generation.get(key) ?? 0;
  const pending = (async () => {
    try {
      const data = await fn();
      if ((generation.get(key) ?? 0) === myGen) {
        cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      }
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, pending);
  return pending;
}

/**
 * Drop any cached entries whose key starts with `prefix`, and generation-guard
 * any in-flight fetch of those keys so a stale settle cannot repopulate the
 * cache after this returns (SPEC_FINAL §1.8). Same-process effect is immediate.
 *
 * Zero pre-existing callers at introduction (grep-verified @1bfc328); the
 * admin-logs/monitor keyspaces never invalidate, so this is inert for them.
 */
export function invalidateCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  // [refactor jul9 P2-A C1] bump generation for any in-flight fetch under this
  // prefix so its eventual cache.set is dropped (stale value), and drop the
  // inflight entry so new callers start a fresh fetch rather than joining it.
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) {
      generation.set(key, (generation.get(key) ?? 0) + 1);
      inflight.delete(key);
    }
  }
}
