// @vitest-environment node
// [table pipeline WP-3.J fix round, VERIFY MED-1] processProject carries `tools.notesAuto` to the two automatic
// notes stages: A12 (`analyzePageIntelligence` note blocks) and A03 (`classifyTextRegions` notes grids). The lib
// tests call those functions directly, so before this file a dropped option at either call site left every test
// green (verifier mutant V3) and WP-3.Q would measure G-PARA on a path still running legacy.
// Both stages run REAL (spies wrap the originals). Mocks are the true edges only, as in
// processing.f4-intelligence-carry.test.ts: S3, rasterize, Textract, keynotes.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  headS3Object: vi.fn(async () => ({ exists: true, size: 8 })),
  uploadToS3: vi.fn(async () => {}),
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
}));
vi.mock("@/lib/pdf-rasterize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rasterizePage: vi.fn(async () => Buffer.alloc(32)),
  getPdfPageCount: vi.fn(async () => 1),
}));
vi.mock("@/lib/textract", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  analyzePageImageWithFallback: vi.fn(async () => ({ lines: [], words: [] })),
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: vi.fn(async () => ({ keynotes: [] as unknown[], warnings: [] as string[] })),
}));
vi.mock("@/lib/page-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/page-analysis")>();
  return { ...orig, analyzePageIntelligence: vi.fn(orig.analyzePageIntelligence) };
});
vi.mock("@/lib/text-region-classifier", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/text-region-classifier")>();
  return { ...orig, classifyTextRegions: vi.fn(orig.classifyTextRegions) };
});

import { processProject } from "@/lib/processing";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const a12 = vi.mocked(analyzePageIntelligence);
const a03 = vi.mocked(classifyTextRegions);

beforeEach(() => {
  a12.mockClear();
  a03.mockClear();
});

describe.skipIf(!dbUp)("processProject — tools.notesAuto reaches A03 and A12", () => {
  it("notesAuto: engine is passed to both stages", async () => {
    const { project } = await createWorld();
    const result = await processProject(project.id, assertProjectWritable(project), { notesAuto: "engine" });
    expect(result.pageErrors).toBe(0);
    expect(a12).toHaveBeenCalledTimes(1);
    expect(a12.mock.calls[0][3]).toEqual({ notesAuto: "engine" });
    expect(a03).toHaveBeenCalledTimes(1);
    expect(a03.mock.calls[0][2]).toMatchObject({ notesAuto: "engine" });
  }, 30000);

  it("notesAuto: legacy is passed as legacy, and no option means no engine (the shipped default)", async () => {
    const { project } = await createWorld();
    await processProject(project.id, assertProjectWritable(project), { notesAuto: "legacy" });
    expect(a12.mock.calls[0][3]).toEqual({ notesAuto: "legacy" });
    expect(a03.mock.calls[0][2]).toMatchObject({ notesAuto: "legacy" });

    const second = await createWorld();
    await processProject(second.project.id, assertProjectWritable(second.project));
    expect(a12).toHaveBeenCalledTimes(2);
    expect((a12.mock.calls[1][3] as { notesAuto?: string } | undefined)?.notesAuto).toBeUndefined();
    expect((a03.mock.calls[1][2] as { notesAuto?: string }).notesAuto).toBeUndefined();
  }, 30000);
});
