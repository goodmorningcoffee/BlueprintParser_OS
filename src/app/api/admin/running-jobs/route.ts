/**
 * GET/PUT /api/admin/running-jobs
 *
 * GET → YOLO jobs with status='running' for the admin's company (resume polling after
 * navigating away). PUT → update a job's status when polling detects completion.
 *
 * [refactor jul6 S046] Thin shells — behavior lives in services/running-jobs.ts
 * (getRunningJobs / updateRunningJob). auth:"admin" (A). GET has no body (no E) and keeps its
 * graceful catch→[] in-service; PUT body:zLooseBody (E: legacy `await req.json()` → shell
 * "Invalid JSON body"). Solo fold (char: admin-running-jobs.route.test.ts RJ-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getRunningJobs, updateRunningJob } from "@/server/services/running-jobs";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getRunningJobs(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body }) => updateRunningJob(body),
});
