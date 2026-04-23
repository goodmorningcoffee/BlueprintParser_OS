import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";
import { logger } from "@/lib/logger";
import { bumpManualBanCacheVersion } from "@/lib/admin-logs/manual-ban-cache";

/**
 * POST /api/admin/logs/ban-ip
 * Body: { ip: string, reason?: string, durationHours?: number }
 *
 * Inserts a row in manual_ip_bans. Middleware reads this table with a 60s
 * in-memory cache; we bump the cache version here so the ban takes effect
 * on the next request in the same task (and within 60s for other tasks).
 */
export async function POST(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  let body: { ip?: string; reason?: string; durationHours?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  if (!ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) {
    return NextResponse.json({ error: "Invalid IP address" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  const bannedUntil =
    typeof body.durationHours === "number" && body.durationHours > 0
      ? new Date(Date.now() + body.durationHours * 3600 * 1000)
      : null;

  try {
    await db
      .insert(manualIpBans)
      .values({
        ip,
        reason,
        bannedByUserId: session.user.dbId,
        bannedUntil,
      })
      .onConflictDoUpdate({
        target: manualIpBans.ip,
        set: { reason, bannedUntil, bannedByUserId: session.user.dbId, createdAt: new Date() },
      });

    bumpManualBanCacheVersion();

    recordAbuseEvent({
      eventType: "MANUAL_BAN",
      ip,
      details: { reason, durationHours: body.durationHours ?? null, actor: session.user.dbId },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("[admin/logs/ban-ip] failed", err);
    return NextResponse.json({ error: "Ban failed" }, { status: 500 });
  }
}
