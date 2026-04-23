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
 * NOT to be used for data that changes based on admin actions (e.g. manual
 * bans). Those fetches stay uncached so ban/unban toggles take effect on
 * the very next refresh.
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

  const pending = (async () => {
    try {
      const data = await fn();
      cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, pending);
  return pending;
}

/**
 * Drop any cached entries whose key starts with `prefix`. Useful if a route
 * wants to force-refresh after a mutation.
 */
export function invalidateCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
