import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Process-local cache of manual_ip_bans rows.
 *
 * Middleware calls `isManuallyBanned(ip)` on every request, so we must not
 * hit the DB per-request. Strategy:
 *   - Cache holds the full Set of banned IPs.
 *   - `setInterval` refreshes the Set every REFRESH_MS in the background.
 *   - `isManuallyBanned()` is sync — returns `Set.has(ip)` with no DB touch,
 *     no await, no blocking. O(1).
 *   - Ban/unban endpoints call `bumpManualBanCacheVersion()` which triggers
 *     an immediate out-of-band refresh on the acting task — other tasks pick
 *     up the change within REFRESH_MS on their own cycle.
 *
 * Earlier design (pre-item-2 follow-up) awaited the refresh inside
 * `isManuallyBanned()` when the cache was stale, causing every request that
 * happened to land at the 60s-stale boundary to block on a shared DB call.
 * The interval-based design here never blocks the request path.
 *
 * Cross-task propagation delay stays bounded at REFRESH_MS. Redis-backed
 * state would make this instant; listed in the post-launch backlog.
 */

const REFRESH_MS = 60_000;

let cachedBans: Set<string> = new Set();
let refreshPromise: Promise<void> | null = null;
let version = 0;

async function refreshCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const rows = await db
        .select({ ip: manualIpBans.ip, bannedUntil: manualIpBans.bannedUntil })
        .from(manualIpBans);
      const now = Date.now();
      const active = new Set<string>();
      for (const row of rows) {
        // Skip expired bans (bannedUntil in the past). null = permanent.
        if (row.bannedUntil && row.bannedUntil.getTime() < now) continue;
        active.add(row.ip);
      }
      cachedBans = active;
    } catch (err) {
      logger.warn("[manual-ban-cache] refresh failed — keeping stale data", err);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// Warm the cache at module import so the first request after an ECS cold
// start sees bans (bar a ~100–500ms window where the refresh is in flight
// and the Set is empty). Then run a background refresh every REFRESH_MS.
void refreshCache();
const refreshInterval: NodeJS.Timeout = setInterval(() => {
  void refreshCache();
}, REFRESH_MS);
// Prevent the interval from keeping the process alive during graceful
// shutdown / test runs. `unref()` is Node-specific and middleware runs in
// Node runtime so this is safe.
if (typeof refreshInterval.unref === "function") refreshInterval.unref();

/**
 * Called by ban-ip / unban-ip route handlers so the admin's own ECS task
 * picks up the change within milliseconds. Other tasks still converge on
 * the next setInterval tick (≤REFRESH_MS).
 */
export function bumpManualBanCacheVersion() {
  version++;
  void refreshCache();
}

/**
 * Synchronous O(1) ban check. Safe to call from middleware on every request.
 * Reflects the state as of the last completed refresh.
 */
export function isManuallyBanned(ip: string): boolean {
  return cachedBans.has(ip);
}

export function manualBanCacheVersion(): number {
  return version;
}
