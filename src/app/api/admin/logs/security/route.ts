import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { abuseEvents, manualIpBans } from "@/lib/db/schema";
import { desc, gte, isNull, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/logs/security
 *
 * Returns recent abuse events + active manual IP bans + per-type tallies.
 * Also marks all currently-unseen events as seen (this is the alert-badge
 * "mark read" side-effect): Root_Admin opening the Security subtab clears
 * the yellow pulse on the Logs tab label.
 */
export async function GET() {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const now = Date.now();
  const day = new Date(now - 24 * 3600 * 1000);
  const week = new Date(now - 7 * 24 * 3600 * 1000);

  try {
    const [events, bans, countLast24h, countLast7d, byType] = await Promise.all([
      db.select().from(abuseEvents).orderBy(desc(abuseEvents.createdAt)).limit(500),
      db.select().from(manualIpBans).orderBy(desc(manualIpBans.createdAt)),
      db.select({ n: sql<number>`count(*)::int` }).from(abuseEvents).where(gte(abuseEvents.createdAt, day)),
      db.select({ n: sql<number>`count(*)::int` }).from(abuseEvents).where(gte(abuseEvents.createdAt, week)),
      db
        .select({
          type: abuseEvents.eventType,
          n: sql<number>`count(*)::int`,
        })
        .from(abuseEvents)
        .where(gte(abuseEvents.createdAt, week))
        .groupBy(abuseEvents.eventType),
    ]);

    // Side-effect: mark all unseen as seen. Fire-and-forget so the response
    // isn't held on the update; this is idempotent and safe under concurrent
    // admins.
    db.update(abuseEvents)
      .set({ seenAt: new Date() })
      .where(isNull(abuseEvents.seenAt))
      .catch((err) => logger.warn("[admin/logs/security] mark-seen failed", err));

    return NextResponse.json({
      abuseEvents: events,
      manualBans: bans,
      violationStats: {
        last24h: countLast24h[0]?.n ?? 0,
        last7d: countLast7d[0]?.n ?? 0,
        byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      },
    });
  } catch (err) {
    logger.error("[admin/logs/security] query failed", err);
    return NextResponse.json({ error: "Security query failed" }, { status: 500 });
  }
}
