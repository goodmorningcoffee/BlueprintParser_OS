/**
 * POST /api/yolo/run-batch  (ROOT ONLY)
 *
 * [2026-10-22 owner: "take full advantage of the larger GPU and its larger quota"] Thin shell —
 * behavior lives in services/yolo-batch-run.ts (yoloRunBatch). Body { modelId, projectIds (1–9) },
 * strictly validated. ONE SageMaker processing job for the listed projects; every project gets its
 * own processing_jobs row sharing the job name, and the per-project guards of /api/yolo/run hold.
 * Answers { jobName, status, projects: [{ projectId, status: "running" | "refused", error? }] }.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { yoloRunBatch, zYoloRunBatchBody } from "@/server/services/yolo-batch-run";

export const POST = defineRoute({
  auth: "root",
  body: zYoloRunBatchBody,
  handler: ({ body, session }) => yoloRunBatch(body, session!),
});
