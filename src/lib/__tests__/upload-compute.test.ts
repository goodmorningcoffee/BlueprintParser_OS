// @vitest-environment node
// [2026-10-23] Upload compute presets (src/lib/upload-compute.ts) + the StartExecution input builder
// (services/processing-start-input.ts) + the worker's page-concurrency resolution (processing.ts).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/services/upload-compute", () => ({ readUploadComputePreset: vi.fn() }));

import {
  DEFAULT_UPLOAD_COMPUTE_PRESET,
  UPLOAD_COMPUTE_PRESETS,
  isUploadComputePreset,
  resolvePageConcurrency,
  resolveUploadComputeSetting,
  uploadComputeExecutionFields,
  uploadComputePreset,
} from "@/lib/upload-compute";
import { buildProcessingStartInput } from "@/server/services/processing-start-input";

/** Fargate's valid task sizes for 4/8/16 vCPU (MiB): 4 vCPU 8–30 GB (1 GB steps), 8 vCPU 16–60 GB (4 GB), 16 vCPU 32–120 GB (8 GB). */
function fargateValid(cpu: number, memory: number): boolean {
  const gb = memory / 1024;
  if (cpu === 4096) return Number.isInteger(gb) && gb >= 8 && gb <= 30;
  if (cpu === 8192) return gb % 4 === 0 && gb >= 16 && gb <= 60;
  if (cpu === 16384) return gb % 8 === 0 && gb >= 32 && gb <= 120;
  return false;
}

describe("upload compute presets", () => {
  it("are exactly 4·16, 8·16 (default), 8·32, 16·32, 16·64 — all Fargate-valid, concurrency = vCPU, strings for ECS", () => {
    expect(UPLOAD_COMPUTE_PRESETS.map((p) => [p.vcpu, p.memoryGiB, p.pageConcurrency])).toEqual([
      [4, 16, 4],
      [8, 16, 8],
      [8, 32, 8],
      [16, 32, 16],
      [16, 64, 16],
    ]);
    expect(DEFAULT_UPLOAD_COMPUTE_PRESET).toBe("8x16");
    for (const p of UPLOAD_COMPUTE_PRESETS) {
      expect(fargateValid(Number(p.cpu), Number(p.memory))).toBe(true);
      expect(uploadComputeExecutionFields(p)).toEqual({ cpu: p.cpu, memory: p.memory, pageConcurrency: String(p.vcpu) });
    }
    // The default is today's task definition (ecs.tf beaver-cpu-pipeline 8192/16384).
    expect(uploadComputeExecutionFields(uploadComputePreset("8x16"))).toEqual({ cpu: "8192", memory: "16384", pageConcurrency: "8" });
  });

  it("only preset ids validate; a stored value resolves leniently to the default", () => {
    expect(isUploadComputePreset("16x64")).toBe(true);
    for (const v of ["16x128", "8X16", " 8x16", 8, null, undefined, { preset: "8x16" }]) expect(isUploadComputePreset(v)).toBe(false);
    expect(resolveUploadComputeSetting({ preset: "4x16" })).toMatchObject({ preset: { id: "4x16" }, valid: true });
    expect(resolveUploadComputeSetting({ preset: "64x512" })).toMatchObject({ preset: { id: "8x16" }, valid: false, raw: "64x512" });
    expect(resolveUploadComputeSetting(undefined)).toMatchObject({ preset: { id: "8x16" }, valid: false });
    expect(resolveUploadComputeSetting("8x16")).toMatchObject({ preset: { id: "8x16" }, valid: false });
  });
});

describe("buildProcessingStartInput (the StartExecution input)", () => {
  it("keeps the five existing fields and adds the preset's cpu / memory / pageConcurrency as strings", () => {
    const env = {
      S3_BUCKET: "beaver-data-1",
      NEXTAUTH_URL: "https://app.example.test",
      PROCESSING_WEBHOOK_SECRET: "s3cret",
    } as unknown as NodeJS.ProcessEnv;
    expect(buildProcessingStartInput({ id: 42, dataUrl: "co/abc" }, uploadComputePreset("16x64"), env)).toEqual({
      projectId: 42,
      dataUrl: "co/abc",
      s3Bucket: "beaver-data-1",
      webhookUrl: "https://app.example.test/api/processing/webhook",
      webhookSecret: "s3cret",
      cpu: "16384",
      memory: "65536",
      pageConcurrency: "16",
    });
  });
});

describe("resolvePageConcurrency (processing.ts)", () => {
  it("company pipeline pageConcurrency wins when set; else PAGE_CONCURRENCY env clamped 1..32; else 8", () => {
    expect(resolvePageConcurrency(12, "16")).toBe(12); // company override beats the preset env
    expect(resolvePageConcurrency(3, undefined)).toBe(3);
    expect(resolvePageConcurrency(undefined, "16")).toBe(16);
    expect(resolvePageConcurrency(null, "4")).toBe(4);
    expect(resolvePageConcurrency(0, "4")).toBe(4); // 0 = unset (the pre-existing `||` semantics)
    expect(resolvePageConcurrency(undefined, "64")).toBe(32);
    expect(resolvePageConcurrency(undefined, "0")).toBe(1);
    expect(resolvePageConcurrency(undefined, "-3")).toBe(1);
    expect(resolvePageConcurrency(undefined, "lots")).toBe(8);
    expect(resolvePageConcurrency(undefined, "")).toBe(8);
    expect(resolvePageConcurrency(undefined, undefined)).toBe(8);
  });

  it("reads process.env.PAGE_CONCURRENCY by default", () => {
    vi.stubEnv("PAGE_CONCURRENCY", "16");
    try {
      expect(resolvePageConcurrency(undefined)).toBe(16);
      expect(resolvePageConcurrency(6)).toBe(6);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("processing.ts resolves its page concurrency through it, company value first", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = (await readFile("src/lib/processing.ts", "utf8")).replace(/\/\/.*$/gmu, "");
    expect(src).toMatch(/let pageConcurrency = resolvePageConcurrency\(undefined\);/u);
    expect(src).toMatch(/pageConcurrency = resolvePageConcurrency\(\(company\?\.pipelineConfig\?\.pipeline as any\)\?\.pageConcurrency\);/u);
    expect(src).not.toMatch(/DEFAULT_PAGE_CONCURRENCY/u);
  });
});
