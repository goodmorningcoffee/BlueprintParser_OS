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
 * (getRecentParses / clearRecentParses). No body on either method → no E;
 * no catch-500 literal → no B. Solo fold (char: admin-recent-parses.route.test.ts RP-*).
 *
 * [TP-1 WP-1.C, K08] auth:"root". op_log holds every company's parse requests (method grids carry
 * cell text) and DELETE wipes all of them, so a company admin may neither read nor clear it.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getRecentParses, clearRecentParses } from "@/server/services/recent-parses";

export const GET = defineRoute({
  auth: "root",
  handler: () => getRecentParses(),
});

export const DELETE = defineRoute({
  auth: "root",
  handler: () => clearRecentParses(),
});
