// [2026-10-22] Bulk YOLO runs as many SageMaker jobs at once as the account's processing-job quota
// for the chosen instance allows (owner: "does our inference code scale up to the quota?"). Quota
// unknown → the old default. A capacity refusal still pauses the queue (yolo-batch.ts), so jobs
// started outside this queue that hold part of the quota only slow it down.

import type { YoloInstanceOptionsResponse } from "@/lib/yolo-cost";
import { DEFAULT_CONCURRENCY } from "./yolo-batch";

/** Upper bound on concurrent jobs one browser tab polls. */
export const MAX_BULK_CONCURRENCY = 50;

export function bulkConcurrency(options: YoloInstanceOptionsResponse | null): number {
  const quota = options?.catalog.options.find((o) => o.type === options.instanceType)?.quota;
  if (typeof quota !== "number" || !Number.isFinite(quota) || quota < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(quota), MAX_BULK_CONCURRENCY);
}

// [2026-10-22 owner: "if there is a quota of ten, I should be able to say use 5 or all 10"] The bulk
// bar's "Machines at once" control. Default = bulkConcurrency (the chosen instance's quota, capped);
// bounds 1 … min(quota, MAX_BULK_CONCURRENCY), or 1 … MAX_BULK_CONCURRENCY when the quota is unknown.

export interface BulkMachineBounds {
  min: 1;
  max: number;
  /** The chosen instance's processing-job quota; null when unknown. */
  quota: number | null;
  defaultValue: number;
}

export function bulkMachineBounds(options: YoloInstanceOptionsResponse | null): BulkMachineBounds {
  const quota = options?.catalog.options.find((o) => o.type === options.instanceType)?.quota;
  const known = typeof quota === "number" && Number.isFinite(quota) && quota >= 1 ? Math.floor(quota) : null;
  return {
    min: 1,
    max: known === null ? MAX_BULK_CONCURRENCY : Math.min(known, MAX_BULK_CONCURRENCY),
    quota: known,
    defaultValue: bulkConcurrency(options),
  };
}

/** The admin's typed value clamped to the bounds; anything unparseable → the default. */
export function clampMachines(value: unknown, bounds: BulkMachineBounds): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return bounds.defaultValue;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)));
}
