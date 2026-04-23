import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";
import { logger } from "@/lib/logger";
import { bumpManualBanCacheVersion } from "@/lib/admin-logs/manual-ban-cache";

/**
 * POST /api/admin/logs/unban-ip
 * Body: { ip: string }
 */
export async function POST(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  let body: { ip?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  if (!ip) return NextResponse.json({ error: "ip required" }, { status: 400 });

  try {
    await db.delete(manualIpBans).where(eq(manualIpBans.ip, ip));
    bumpManualBanCacheVersion();
    recordAbuseEvent({
      eventType: "MANUAL_UNBAN",
      ip,
      details: { actor: session.user.dbId },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("[admin/logs/unban-ip] failed", err);
    return NextResponse.json({ error: "Unban failed" }, { status: 500 });
  }
}
