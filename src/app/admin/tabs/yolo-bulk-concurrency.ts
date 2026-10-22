// [2026-10-22] Bulk YOLO runs as many SageMaker jobs at once as the account's processing-job quota
// for the chosen instance allows (owner: "does our inference code scale up to the quota?"). Quota
// unknown → the old default. A capacity refusal still pauses the queue (yolo-batch.ts), so jobs
// started outside this queue that hold part of the quota only slow it down.

import type { YoloInstanceOptionsResponse } from "@/lib/yolo-cost";
import { DEFAULT_CONCURRENCY } from "./yolo-batch";

/** Upper bound on concurrent jobs one browser tab polls. */
export const MAX_BULK_CONCURRENCY = 20;

export function bulkConcurrency(options: YoloInstanceOptionsResponse | null): number {
  const quota = options?.catalog.options.find((o) => o.type === options.instanceType)?.quota;
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(quota), MAX_BULK_CONCURRENCY);
}
