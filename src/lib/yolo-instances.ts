// [2026-10-21 owner ask] Which SageMaker instance runs YOLO processing jobs. Pure and client-safe:
// the admin picker renders this list, the server validates writes against it, and startYoloJob
// (src/lib/yolo.ts) falls back to the default for anything not on it.
//
// The YOLO image is torch 2.7.1+cu118, so only NVIDIA GPU families can accelerate it (g4dn T4,
// g5 A10G, g6 L4, g6e L40S, p3 V100); the CPU types run but are slow. Inferentia/Trainium are
// excluded. Every entry is also a member of the SDK's ProcessingInstanceType enum (test-pinned).
// The inference script uses ONE GPU, so a multi-GPU size only buys vCPU/RAM. Prices are rough
// on-demand us-east-1 SageMaker rates, for comparison only.

export const YOLO_INSTANCE_SETTING_KEY = "yolo_instance_type";
export const DEFAULT_YOLO_INSTANCE_TYPE = "ml.g4dn.xlarge";

export interface YoloInstanceOption {
  type: string;
  /** e.g. "T4 16 GB"; null for CPU-only types. */
  gpu: string | null;
  gpus: number;
  vcpu: number;
  memoryGiB: number;
  /** Rough on-demand $/hour (us-east-1). */
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
  gpu("ml.g5.xlarge", "A10G 24 GB", 1, 4, 16, 1.41),
  gpu("ml.g5.2xlarge", "A10G 24 GB", 1, 8, 32, 1.52),
  gpu("ml.g5.4xlarge", "A10G 24 GB", 1, 16, 64, 2.03),
  gpu("ml.g5.8xlarge", "A10G 24 GB", 1, 32, 128, 3.06),
  gpu("ml.g5.12xlarge", "A10G 24 GB", 4, 48, 192, 7.09),
  gpu("ml.g6.xlarge", "L4 24 GB", 1, 4, 16, 1.01),
  gpu("ml.g6.2xlarge", "L4 24 GB", 1, 8, 32, 1.22),
  gpu("ml.g6.4xlarge", "L4 24 GB", 1, 16, 64, 1.65),
  gpu("ml.g6.8xlarge", "L4 24 GB", 1, 32, 128, 2.52),
  gpu("ml.g6e.xlarge", "L40S 48 GB", 1, 4, 32, 2.33),
  gpu("ml.g6e.2xlarge", "L40S 48 GB", 1, 8, 64, 2.8),
  gpu("ml.p3.2xlarge", "V100 16 GB", 1, 8, 61, 3.83),
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
