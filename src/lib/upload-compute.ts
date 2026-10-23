// [2026-10-23 owner ask] Root-only compute size for the upload processing task (the Fargate CPU
// pipeline that Step Functions starts per uploaded project). Pure and client-safe: the admin picker
// renders this list, the server validates writes against it, and the StartExecution input builder
// (services/processing-start-input.ts) falls back to the default for anything not on it.
//
// Every preset is a Fargate-valid task size (4 vCPU: 8–30 GB; 8 vCPU: 16–60 GB in 4 GB steps;
// 16 vCPU: 32–120 GB in 8 GB steps; 8/16 vCPU need platform 1.4.0, which the state machine pins).
// The state machine overrides the task definition's 8192/16384 with `cpu`/`memory` from the
// execution input and passes `pageConcurrency` as the container's PAGE_CONCURRENCY env, which
// src/lib/processing.ts uses unless the company's own pipeline pageConcurrency is set. All three ride
// as STRINGS because ECS RunTask overrides and container env values are strings.

export const UPLOAD_COMPUTE_SETTING_KEY = "upload_compute_preset";
export const DEFAULT_UPLOAD_COMPUTE_PRESET = "8x16";

export interface UploadComputePreset {
  id: string;
  vcpu: number;
  memoryGiB: number;
  /** Fargate task CPU units, e.g. "8192". */
  cpu: string;
  /** Fargate task memory MiB, e.g. "16384". */
  memory: string;
  /** Parallel pages in the worker (= vCPU count). */
  pageConcurrency: number;
}

const preset = (vcpu: number, memoryGiB: number): UploadComputePreset => ({
  id: `${vcpu}x${memoryGiB}`,
  vcpu,
  memoryGiB,
  cpu: String(vcpu * 1024),
  memory: String(memoryGiB * 1024),
  pageConcurrency: vcpu,
});

export const UPLOAD_COMPUTE_PRESETS: readonly UploadComputePreset[] = [
  preset(4, 16),
  preset(8, 16),
  preset(8, 32),
  preset(16, 32),
  preset(16, 64),
];

export function isUploadComputePreset(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_COMPUTE_PRESETS.some((p) => p.id === value);
}

export function uploadComputePreset(id: string): UploadComputePreset {
  return (
    UPLOAD_COMPUTE_PRESETS.find((p) => p.id === id) ??
    (UPLOAD_COMPUTE_PRESETS.find((p) => p.id === DEFAULT_UPLOAD_COMPUTE_PRESET) as UploadComputePreset)
  );
}

/** Lenient read of the stored app_settings value ({ preset }). Off-list/missing → default, valid:false. */
export function resolveUploadComputeSetting(value: unknown): { preset: UploadComputePreset; valid: boolean; raw: unknown } {
  const raw = value && typeof value === "object" ? (value as { preset?: unknown }).preset : undefined;
  return isUploadComputePreset(raw)
    ? { preset: uploadComputePreset(raw), valid: true, raw }
    : { preset: uploadComputePreset(DEFAULT_UPLOAD_COMPUTE_PRESET), valid: false, raw };
}

export function uploadComputeLabel(p: UploadComputePreset): string {
  return `${p.vcpu} vCPU · ${p.memoryGiB} GB · ${p.pageConcurrency} pages at once${p.id === DEFAULT_UPLOAD_COMPUTE_PRESET ? " (default)" : ""}`;
}

/** The fields the StartExecution input carries for the CPUProcessing task overrides. */
export function uploadComputeExecutionFields(p: UploadComputePreset): { cpu: string; memory: string; pageConcurrency: string } {
  return { cpu: p.cpu, memory: p.memory, pageConcurrency: String(p.pageConcurrency) };
}

export const MIN_ENV_PAGE_CONCURRENCY = 1;
export const MAX_ENV_PAGE_CONCURRENCY = 32;
export const DEFAULT_PAGE_CONCURRENCY = 8;

/**
 * The worker's page concurrency. The company's pipeline pageConcurrency wins whenever it is set
 * (truthy — the pre-existing `||` semantics, value used as-is); otherwise the PAGE_CONCURRENCY env the
 * state machine sets from the upload compute preset, clamped to 1..32; otherwise 8.
 */
export function resolvePageConcurrency(companyValue: unknown, envValue: string | undefined = process.env.PAGE_CONCURRENCY): number {
  if (companyValue) return companyValue as number;
  const parsed = envValue === undefined ? Number.NaN : Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_CONCURRENCY;
  return Math.min(MAX_ENV_PAGE_CONCURRENCY, Math.max(MIN_ENV_PAGE_CONCURRENCY, parsed));
}
