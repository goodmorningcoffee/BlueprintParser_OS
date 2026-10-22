// [2026-10-21 owner ask; stage 2 2026-10-22] Which SageMaker instance runs YOLO processing jobs. Pure
// and client-safe: the admin picker renders this list, the server validates writes against it, and
// startYoloJob (src/lib/yolo.ts) falls back to the default for anything not on it.
//
// The YOLO image is torch 2.7.1+cu118, so only NVIDIA GPU families can accelerate it. Stage 2 (owner
// 2026-10-22: "select any gpu that we have a quota for"): EVERY size of the g4dn (T4), g5 (A10G),
// g6 (L4), g6e (L40S), p3 (V100) and p5 (H100) families that the SDK accepts for a PROCESSING job
// (p4d has no processing type in the SDK enum), plus the stage-1 CPU types (slow). The admin picker
// narrows this to the types with a live processing-job quota > 0 (services/yolo-instance-catalog.ts).
// Inferentia/Trainium/AMD are excluded. Every entry is a member of the SDK's ProcessingInstanceType
// enum (test-pinned). [2026-10-22] The inference script runs one worker per GPU over a shared page queue,
// so `gpus` divides a job's inference time (src/lib/yolo-cost.ts, src/lib/yolo-chunk-plan.ts).
// usdPerHour is a rough on-demand us-east-1 rate, the fallback when the live Price List is unreachable.

export const YOLO_INSTANCE_SETTING_KEY = "yolo_instance_type";
export const DEFAULT_YOLO_INSTANCE_TYPE = "ml.g4dn.xlarge";

export interface YoloInstanceOption {
  type: string;
  /** e.g. "T4 16 GB"; null for CPU-only types. */
  gpu: string | null;
  gpus: number;
  vcpu: number;
  memoryGiB: number;
  /** Rough on-demand $/hour (us-east-1); the fallback when the live Price List is unreachable. */
  usdPerHour: number;
}

const gpu = (type: string, gpuName: string, gpus: number, vcpu: number, memoryGiB: number, usdPerHour: number): YoloInstanceOption =>
  ({ type, gpu: gpuName, gpus, vcpu, memoryGiB, usdPerHour });
const cpu = (type: string, vcpu: number, memoryGiB: number, usdPerHour: number): YoloInstanceOption =>
  ({ type, gpu: null, gpus: 0, vcpu, memoryGiB, usdPerHour });

export const YOLO_INSTANCE_OPTIONS: readonly YoloInstanceOption[] = [
  gpu("ml.g4dn.xlarge", "T4 16 GB", 1, 4, 16, 0.74),
  gpu("ml.g4dn.2xlarge", "T4 16 GB", 1, 8, 32, 1.05),
  gpu("ml.g4dn.4xlarge", "T4 16 GB", 1, 16, 64, 1.69),
  gpu("ml.g4dn.8xlarge", "T4 16 GB", 1, 32, 128, 3.05),
  gpu("ml.g4dn.12xlarge", "T4 16 GB", 4, 48, 192, 5.48),
  gpu("ml.g4dn.16xlarge", "T4 16 GB", 1, 64, 256, 6.09),
  gpu("ml.g5.xlarge", "A10G 24 GB", 1, 4, 16, 1.41),
  gpu("ml.g5.2xlarge", "A10G 24 GB", 1, 8, 32, 1.52),
  gpu("ml.g5.4xlarge", "A10G 24 GB", 1, 16, 64, 2.03),
  gpu("ml.g5.8xlarge", "A10G 24 GB", 1, 32, 128, 3.06),
  gpu("ml.g5.12xlarge", "A10G 24 GB", 4, 48, 192, 7.09),
  gpu("ml.g5.16xlarge", "A10G 24 GB", 1, 64, 256, 5.12),
  gpu("ml.g5.24xlarge", "A10G 24 GB", 4, 96, 384, 10.18),
  gpu("ml.g5.48xlarge", "A10G 24 GB", 8, 192, 768, 20.36),
  gpu("ml.g6.xlarge", "L4 24 GB", 1, 4, 16, 1.01),
  gpu("ml.g6.2xlarge", "L4 24 GB", 1, 8, 32, 1.22),
  gpu("ml.g6.4xlarge", "L4 24 GB", 1, 16, 64, 1.65),
  gpu("ml.g6.8xlarge", "L4 24 GB", 1, 32, 128, 2.52),
  gpu("ml.g6.12xlarge", "L4 24 GB", 4, 48, 192, 5.8),
  gpu("ml.g6.16xlarge", "L4 24 GB", 1, 64, 256, 4.25),
  gpu("ml.g6.24xlarge", "L4 24 GB", 4, 96, 384, 8.38),
  gpu("ml.g6.48xlarge", "L4 24 GB", 8, 192, 768, 16.77),
  gpu("ml.g6e.xlarge", "L40S 48 GB", 1, 4, 32, 2.33),
  gpu("ml.g6e.2xlarge", "L40S 48 GB", 1, 8, 64, 2.8),
  gpu("ml.g6e.4xlarge", "L40S 48 GB", 1, 16, 128, 3.72),
  gpu("ml.g6e.8xlarge", "L40S 48 GB", 1, 32, 256, 5.58),
  gpu("ml.g6e.12xlarge", "L40S 48 GB", 4, 48, 384, 13.12),
  gpu("ml.g6e.16xlarge", "L40S 48 GB", 1, 64, 512, 9.3),
  gpu("ml.g6e.24xlarge", "L40S 48 GB", 4, 96, 768, 18.85),
  gpu("ml.g6e.48xlarge", "L40S 48 GB", 8, 192, 1536, 37.69),
  gpu("ml.p3.2xlarge", "V100 16 GB", 1, 8, 61, 3.83),
  gpu("ml.p3.8xlarge", "V100 16 GB", 4, 32, 244, 14.69),
  gpu("ml.p3.16xlarge", "V100 16 GB", 8, 64, 488, 28.15),
  gpu("ml.p5.4xlarge", "H100 80 GB", 1, 16, 256, 9.6),
  cpu("ml.m5.xlarge", 4, 16, 0.23),
  cpu("ml.m5.2xlarge", 8, 32, 0.46),
  cpu("ml.m5.4xlarge", 16, 64, 0.92),
  cpu("ml.c5.2xlarge", 8, 16, 0.41),
  cpu("ml.c5.4xlarge", 16, 32, 0.82),
];

export const YOLO_INSTANCE_TYPES: readonly string[] = YOLO_INSTANCE_OPTIONS.map((o) => o.type);

export function isYoloInstanceType(value: unknown): value is string {
  return typeof value === "string" && YOLO_INSTANCE_TYPES.includes(value);
}

/**
 * Lenient read of the stored app_settings value ({ instanceType }). Anything missing or not on the
 * allowlist resolves to the default with `valid: false` so the caller can log it. Never throws.
 */
export function resolveYoloInstanceSetting(value: unknown): { instanceType: string; valid: boolean; raw: unknown } {
  const raw = value && typeof value === "object" ? (value as { instanceType?: unknown }).instanceType : undefined;
  return isYoloInstanceType(raw)
    ? { instanceType: raw, valid: true, raw }
    : { instanceType: DEFAULT_YOLO_INSTANCE_TYPE, valid: false, raw };
}

export function yoloInstanceLabel(o: YoloInstanceOption): string {
  const hw = o.gpu ? `${o.gpus > 1 ? `${o.gpus}× ` : ""}${o.gpu}` : "CPU only (slow)";
  return `${o.type} — ${hw} · ${o.vcpu} vCPU · ${o.memoryGiB} GiB · ≈$${o.usdPerHour.toFixed(2)}/h`;
}

/** The Service Quotas name of the processing-job quota for a type (what an increase request names). */
export function yoloProcessingQuotaName(instanceType: string): string {
  return `${instanceType} for processing job usage`;
}

/** Inverse of yoloProcessingQuotaName: the instance type a quota name covers, or null. */
export function instanceTypeFromQuotaName(quotaName: unknown): string | null {
  if (typeof quotaName !== "string") return null;
  const m = /^(ml\.[a-z0-9-]+\.[a-z0-9]+) for processing job usage$/u.exec(quotaName.trim());
  return m ? m[1] : null;
}

// [2026-10-22 owner: "ability to modify timeout time in the admin"] The processing job's
// StoppingCondition.MaxRuntimeInSeconds. Root-only app_settings value { seconds }, bounded 15 min–24 h.
export const YOLO_MAX_RUNTIME_SETTING_KEY = "yolo_max_runtime_seconds";
export const DEFAULT_YOLO_MAX_RUNTIME_SECONDS = 3600;
export const MIN_YOLO_MAX_RUNTIME_SECONDS = 900;
export const MAX_YOLO_MAX_RUNTIME_SECONDS = 86400;

export function isYoloMaxRuntimeSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_YOLO_MAX_RUNTIME_SECONDS && value <= MAX_YOLO_MAX_RUNTIME_SECONDS;
}

/** Lenient read of the stored { seconds }: anything missing or out of bounds → the default (valid:false). */
export function resolveYoloMaxRuntimeSetting(value: unknown): { seconds: number; valid: boolean; raw: unknown } {
  const raw = value && typeof value === "object" ? (value as { seconds?: unknown }).seconds : undefined;
  return isYoloMaxRuntimeSeconds(raw)
    ? { seconds: raw, valid: true, raw }
    : { seconds: DEFAULT_YOLO_MAX_RUNTIME_SECONDS, valid: false, raw };
}

/** The user-facing refusal when SageMaker has no free capacity under the account quota for a type. */
export function yoloQuotaMessage(instanceType: string): string {
  return `No SageMaker quota for ${instanceType} processing jobs (ResourceLimitExceeded): the account limit ` +
    `for this instance type is 0 or already in use. Wait for running jobs, request a quota increase ` +
    `("${instanceType} for processing job usage"), or pick another inference instance.`;
}

/**
 * True when a Describe* call says the named job does not exist. SageMaker answers a missing
 * processing job with ValidationException "Could not find requested job …" (ResourceNotFound in
 * the API reference), so both are accepted; anything else — throttling, network — is not proof.
 */
export function isSageMakerNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === "ResourceNotFound") return true;
  return e.name === "ValidationException" && typeof e.message === "string" &&
    /could not find|not found|does not exist/iu.test(e.message);
}

/** True for the SDK error SageMaker returns when a processing-job instance quota is exhausted. */
export function isSageMakerQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; Code?: unknown; __type?: unknown };
  return [e.name, e.Code, e.__type].some((v) => typeof v === "string" && /ResourceLimitExceeded/u.test(v));
}
