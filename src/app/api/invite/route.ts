/**
 * POST /api/invite
 *
 * [refactor jul6 S034] Thin shell — behavior lives in services/invite-register.ts
 * (inviteRequest). auth:"none" — the PUBLIC invite-request form (demo page + login
 * form; docs mislabel it admin — P1 ledger). body:zLooseBody (diff E; the FIXED
 * "Failed to submit" catch retired → shell generic, diff B/S015 class). Path pinned
 * by the middleware ip rate rule on POST /api/invite.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { inviteRequest } from "@/server/services/invite-register";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => inviteRequest(body),
});
