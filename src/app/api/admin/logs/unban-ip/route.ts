/**
 * POST /api/admin/logs/unban-ip
 * Body: { ip: string }
 *
 * [refactor jul6 S039] Thin shell — behavior lives in services/manual-ip-bans.ts (unbanIp).
 * auth:"root" (A). body:zLooseBody (E: malformed → shell 400 "Invalid JSON body"). The
 * "ip required" validation (NO regex, unlike ban), delete, cache-bump + MANUAL_UNBAN abuse
 * event stay in-service. Diff B: the "Unban failed" catch-500 literal retired → generic
 * INTERNAL 500. Part of the ADMIN B4 write-cluster (char: admin-ban-ip.route.test.ts UNBAN-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { unbanIp } from "@/server/services/manual-ip-bans";

export const POST = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body, session }) => unbanIp(body, session!),
});
