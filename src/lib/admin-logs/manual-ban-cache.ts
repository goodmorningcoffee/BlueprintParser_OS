import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Process-local cache of manual_ip_bans rows.
 *
 * Middleware calls `isManuallyBanned(ip)` on every request, so we must not
 * hit the DB per-request. Strategy:
 *   - Cache holds the full Set of banned IPs + an ISO timestamp.
 *   - Refreshes in the background every 60s.
 *   - Manual ban/unban endpoints call `bumpManualBanCacheVersion()` to
 *     invalidate the cache immediately in the current task (other ECS tasks
 *     pick up the change within 60s on their own refresh cycle).
 *
 * Cross-task propagation delay is bounded at 60s, which matches our
 * "no distributed state" constraint for launch. Redis upgrade would make
 * this instant — listed in the post-launch backlog.
 */

const REFRESH_MS = 60_000;

let cachedBans: Set<string> = new Set();
let cachedAt = 0;
let version = 0;
let refreshPromise: Promise<void> | null = null;

async function refreshCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const rows = await db.select({ ip: manualIpBans.ip, bannedUntil: manualIpBans.bannedUntil }).from(manualIpBans);
      const now = Date.now();
      const active = new Set<string>();
      for (const row of rows) {
        // Skip expired bans (bannedUntil in the past). null = permanent.
        if (row.bannedUntil && row.bannedUntil.getTime() < now) continue;
        active.add(row.ip);
      }
      cachedBans = active;
      cachedAt = now;
    } catch (err) {
      logger.warn("[manual-ban-cache] refresh failed — keeping stale data", err);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function bumpManualBanCacheVersion() {
  version++;
  cachedAt = 0; // Force refresh on next isManuallyBanned() call.
}

export async function isManuallyBanned(ip: string): Promise<boolean> {
  if (Date.now() - cachedAt > REFRESH_MS) {
    await refreshCache();
  }
  return cachedBans.has(ip);
}

export function manualBanCacheVersion(): number {
  return version;
}
