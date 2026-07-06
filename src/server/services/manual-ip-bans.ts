// [refactor jul6 S039] ADMIN B4 write-cluster — the 2 root IP-ban write contracts (ban-ip,
// unban-ip), folded from the legacy routes (git show 08763ad:src/app/api/admin/logs/{ban,unban}-ip
// /route.ts at the freeze). Char: __tests__/admin-ban-ip.route.test.ts (BAN/UNBAN).
//
// Both are requireRootAdmin POST writes (shell provides auth:"root"). Sanctioned diffs:
//   • A — flat auth errors → envelope; the ip-validation 400 literals stay byte-verbatim
//     here as ApiError("VALIDATION", ...): ban "Invalid IP address", unban "ip required".
//   • B — the fixed catch-500 literals ("Ban failed" / "Unban failed", no err.message leak)
//     are RETIRED: the service lets the error propagate → shell generic INTERNAL 500 (real
//     cause logged server-side by defineRoute). S032 precedent.
//   • E — the legacy route's own req.json() try/catch (400 "Invalid JSON") is subsumed by the
//     shell's raw-parse (malformed → 400 BAD_REQUEST "Invalid JSON body", pre-auth). The
//     shell hands the service a parsed object; the service keeps the FIELD validation.
// PRESERVED verbatim: ip trim; ban's regex+length gate + reason slice(0,500) +
// durationHours→bannedUntil + onConflictDoUpdate idempotent upsert; unban's delete +
// non-existent-ip no-op success; bumpManualBanCacheVersion() AFTER the write, BEFORE the
// fire-and-forget recordAbuseEvent(MANUAL_BAN/MANUAL_UNBAN, actor).

import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";
import { bumpManualBanCacheVersion } from "@/lib/admin-logs/manual-ban-cache";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

export async function banIp(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const body = rawBody as { ip?: unknown; reason?: unknown; durationHours?: unknown };

  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  if (!ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) {
    throw new ApiError("VALIDATION", "Invalid IP address");
  }

  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  const bannedUntil =
    typeof body.durationHours === "number" && body.durationHours > 0
      ? new Date(Date.now() + body.durationHours * 3600 * 1000)
      : null;

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
    details: { reason, durationHours: (body.durationHours as number) ?? null, actor: session.user.dbId },
  });

  return { ok: true };
}

export async function unbanIp(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const body = rawBody as { ip?: unknown };

  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  if (!ip) throw new ApiError("VALIDATION", "ip required");

  await db.delete(manualIpBans).where(eq(manualIpBans.ip, ip));
  bumpManualBanCacheVersion();
  recordAbuseEvent({
    eventType: "MANUAL_UNBAN",
    ip,
    details: { actor: session.user.dbId },
  });
  return { ok: true };
}
