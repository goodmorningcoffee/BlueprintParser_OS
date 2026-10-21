/**
 * GET /api/admin/stuck-jobs — Admin › Data tools › Stuck jobs listing (running ingest + YOLO rows,
 * active leases, live provider status, root-only unlinked compute reservations).
 * Thin shell — behaviour lives in services/stuck-jobs.ts. Company admin = own company; root = all
 * or `?companyId`.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { listStuckJobs, zStuckJobsQuery } from "@/server/services/stuck-jobs";

export const GET = defineRoute({
  auth: "admin",
  query: zStuckJobsQuery,
  handler: ({ query, session }) => listStuckJobs(session!, query),
});
