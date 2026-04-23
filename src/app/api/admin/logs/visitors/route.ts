import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { runInsightsQuery, oldestLogTimestampMs, type InsightsWindow } from "@/lib/admin-logs/cw-logs";
import { cachedQuery } from "@/lib/admin-logs/query-cache";
import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/logs/visitors?range=1h|24h|7d|30d
 *
 * Groups the `[visit]` CloudWatch stream by IP → per-IP summary. Sorted by
 * request count desc (engagement proxy). Joins in `manual_ip_bans` so the
 * UI can show a Ban/Unban button without a second round-trip.
 *
 * Also returns `retentionWarning` when the oldest log stream is within 3
 * days of the 30-day CW retention rollover — drives the yellow banner in
 * the Logs tab UI.
 */
export async function GET(req: Request) {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const range = (new URL(req.url).searchParams.get("range") || "24h") as InsightsWindow["range"];
  if (!["1h", "24h", "7d", "30d"].includes(range)) {
    return NextResponse.json({ error: "range must be 1h|24h|7d|30d" }, { status: 400 });
  }

  const queryString = `
    fields @timestamp, ip, country, method, path, status, userAgent, authed, sessionId
    | filter tag = "visit"
    | filter ispresent(ip)
    | stats count(*) as requests,
            min(@timestamp) as firstSeenTs,
            max(@timestamp) as lastSeenTs,
            count_distinct(path) as uniquePaths,
            count_distinct(sessionId) as uniqueSessions,
            max(country) as country,
            max(userAgent) as userAgent,
            max(authed) as authed
      by ip
    | sort requests desc
    | limit 100
  `;

  try {
    // Cache ONLY the Insights query (expensive, deterministic for a given
    // range). Leave manualBans + oldestLogTimestampMs uncached so ban/unban
    // actions take effect on the next Visitors refresh without a cache
    // invalidation dance.
    const [rows, manualBans, oldestMs] = await Promise.all([
      cachedQuery(
        `visitors:${range}`,
        60_000,
        () => runInsightsQuery(queryString, { range }, { limit: 100 }),
      ),
      db.select().from(manualIpBans),
      oldestLogTimestampMs(),
    ]);

    const bannedIps = new Set(manualBans.map((b) => b.ip));

    const visitors = rows.map((row) => {
      const firstSeen = row.firstSeenTs ? new Date(row.firstSeenTs).toISOString() : null;
      const lastSeen = row.lastSeenTs ? new Date(row.lastSeenTs).toISOString() : null;
      const durationMs =
        row.firstSeenTs && row.lastSeenTs
          ? new Date(row.lastSeenTs).getTime() - new Date(row.firstSeenTs).getTime()
          : 0;
      return {
        ip: row.ip,
        country: row.country || "??",
        requests: Number(row.requests || 0),
        firstSeen,
        lastSeen,
        durationMs,
        uniquePaths: Number(row.uniquePaths || 0),
        uniqueSessions: Number(row.uniqueSessions || 0),
        userAgent: row.userAgent || "",
        authed: row.authed === "1" || row.authed === "true",
        isManuallyBanned: bannedIps.has(row.ip),
      };
    });

    // Retention banner: fire when oldest log is within 3 days of the 30-day cap.
    const retentionCapDays = 30;
    const warnThresholdDays = 3;
    let retentionWarning: { daysUntilRollover: number } | null = null;
    if (oldestMs) {
      const ageDays = (Date.now() - oldestMs) / (24 * 3600 * 1000);
      const daysUntilRollover = Math.floor(retentionCapDays - ageDays);
      if (daysUntilRollover <= warnThresholdDays && daysUntilRollover >= 0) {
        retentionWarning = { daysUntilRollover };
      }
    }

    return NextResponse.json({
      range,
      visitors,
      retentionWarning,
    });
  } catch (err) {
    logger.error("[admin/logs/visitors] query failed", err);
    return NextResponse.json({ error: "Visitor query failed" }, { status: 500 });
  }
}
