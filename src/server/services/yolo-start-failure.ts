// [2026-10-22 bulk YOLO incident] What yoloRun and yoloRunBatch do when CreateProcessingJob throws.
// A provider-confirmed refusal (lib/yolo-start-errors: confirmedAbsent) closes the job intents AT ONCE
// as failed — error "SageMaker job never accepted: <AWS reason>", which the daily job quota does not
// count (lib/quotas) — and the caller releases page reservations; the run leases are released by
// the caller's lease wrapper when it throws. An unconfirmed outcome keeps the rows as fail-closed
// "outcome unknown" intents (the job may exist), exactly as before. The writes stay in the callers
// (project-security-policy: every processing_jobs write sits in a withProjectWrite(s) callback).

import { logger } from "@/lib/logger";
import { YoloStartRefusedError } from "@/lib/yolo-start-errors";
import { ApiError } from "@/server/api/envelope";

/** Prefix of a closed row's error when SageMaker never accepted the job (quota-exempt). */
export const YOLO_NEVER_ACCEPTED = "SageMaker job never accepted";

/** The processing_jobs patch for the start's rows; `refused` → the caller also releases reservations. */
export function startFailureRowPatch(err: unknown): {
  refused: boolean;
  set: { status?: "failed"; completedAt?: Date; error: string };
} {
  if (err instanceof YoloStartRefusedError && err.confirmedAbsent) {
    return { refused: true, set: { status: "failed", completedAt: new Date(), error: `${YOLO_NEVER_ACCEPTED}: ${err.message}`.slice(0, 500) } };
  }
  return { refused: false, set: { error: "SageMaker start outcome unknown" } };
}

/** Log the start failure and turn it into the route's answer (the classified refusal passes through). */
export function startFailureAnswer(err: unknown, label: string): ApiError {
  logger.error(`${label} job start failed:`, err);
  return err instanceof ApiError ? err : new ApiError("INTERNAL", "Failed to start SageMaker job");
}
