/**
 * POST /api/admin/logs/ban-ip
 * Body: { ip: string, reason?: string, durationHours?: number }
 *
 * [refactor jul6 S039] Thin shell — behavior lives in services/manual-ip-bans.ts (banIp).
 * auth:"root" (A). body:zLooseBody (E: malformed → shell 400 "Invalid JSON body"). The
 * "Invalid IP address" validation, onConflictDoUpdate upsert, cache-bump + MANUAL_BAN abuse
 * event stay in-service. Diff B: the "Ban failed" catch-500 literal retired → generic
 * INTERNAL 500. Part of the ADMIN B4 write-cluster (char: admin-ban-ip.route.test.ts BAN-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { banIp } from "@/server/services/manual-ip-bans";

export const POST = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body, session }) => banIp(body, session!),
});
