/**
 * POST /api/admin/stuck-jobs/force-release — root only: release a project's web-held mutation
 * leases (kinds matched by prefix; worker `project-processing` excluded) after the operator types
 * the project name. Audited. Thin shell — services/stuck-jobs.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  forceReleaseStuckLeases,
  zStuckForceReleaseBody,
} from "@/server/services/stuck-jobs";

export const POST = defineRoute({
  auth: "root",
  body: zStuckForceReleaseBody,
  handler: ({ body, session }) => forceReleaseStuckLeases(session!, body),
});
