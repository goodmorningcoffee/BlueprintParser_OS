/**
 * GET/PUT /api/admin/invites  (admin invite-request inbox: list + mark-all-seen)
 *
 * [refactor jul6 S042] Thin shells — behavior lives in services/invites.ts (getInvites /
 * markInvitesSeen). auth:"admin" (A). Neither method reads a body → no E; no catch-500
 * literal → no B. Solo fold (char: admin-invites.route.test.ts INV-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getInvites, markInvitesSeen } from "@/server/services/invites";

export const GET = defineRoute({
  auth: "admin",
  handler: () => getInvites(),
});

export const PUT = defineRoute({
  auth: "admin",
  handler: () => markInvitesSeen(),
});
