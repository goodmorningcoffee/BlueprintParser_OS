/**
 * /api/admin/recent-parses
 *
 * Phase I.2.c: Read the in-memory ring buffer of recent table-parse requests for the admin
 * debug UI. Returns the last N parses with FULL methodResults including subprocess stderr,
 * intermediate state, and timing.
 *
 * GET    → list all entries in the ring buffer (newest first)
 * DELETE → clear the ring buffer
 *
 * Multi-replica ECS gotcha: each task has its own buffer. The admin page may see different
 * "recent parses" depending on which task served the request. Acceptable for MVP.
 *
 * [refactor jul6 S044] Thin shells — behavior lives in services/recent-parses.ts
 * (getRecentParses / clearRecentParses). auth:"admin" (A). No body on either method → no E;
 * no catch-500 literal → no B. Solo fold (char: admin-recent-parses.route.test.ts RP-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getRecentParses, clearRecentParses } from "@/server/services/recent-parses";

export const GET = defineRoute({
  auth: "admin",
  handler: () => getRecentParses(),
});

export const DELETE = defineRoute({
  auth: "admin",
  handler: () => clearRecentParses(),
});
