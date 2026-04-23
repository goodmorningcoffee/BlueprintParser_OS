import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { abuseEvents } from "@/lib/db/schema";
import { desc, isNull, sql } from "drizzle-orm";

/**
 * GET /api/admin/logs/alert-count
 *
 * Fast count of unseen abuse_events. Drives the yellow badge on the Logs
 * admin tab. Root_Admin's browser polls this every 60s; opening the
 * Security subtab marks everything seen (side-effect of the /security
 * endpoint).
 */
export async function GET() {
  const { error } = await requireRootAdmin();
  if (error) return error;

  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(abuseEvents)
      .where(isNull(abuseEvents.seenAt));

    const [latest] = await db
      .select({ createdAt: abuseEvents.createdAt })
      .from(abuseEvents)
      .where(isNull(abuseEvents.seenAt))
      .orderBy(desc(abuseEvents.createdAt))
      .limit(1);

    return NextResponse.json({
      unseen: row?.n ?? 0,
      latestEventAt: latest?.createdAt ?? null,
    });
  } catch {
    // Fail quietly — if the DB hiccups we don't want to light up the badge.
    return NextResponse.json({ unseen: 0, latestEventAt: null });
  }
}
