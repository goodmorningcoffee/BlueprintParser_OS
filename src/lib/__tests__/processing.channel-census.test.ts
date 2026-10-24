// @vitest-environment node
// [census F2 2026-10-24] processProject runs the upload channel census ONCE per run, BESIDE the page
// loop (pages never wait for it), awaits it after the loop and merges pageIntelligence.channels into
// each page row; the project summary lands at projectIntelligence.channels and survives the later
// project-analysis merge. A census whose page count differs from numPages writes no page record. FAIL-SOFT: a census that throws is one warning — the upload completes and pages carry no
// channels key. Mocks: the same true edges as processing.f4-intelligence-carry.test.ts plus the
// python runner (scripts/test_pdf_channels.py covers the script itself).
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const s3Mocks = vi.hoisted(() => ({
  headS3Object: vi.fn(async () => ({ exists: true, size: 8 })),
  uploadToS3: vi.fn(async () => {}),
  downloadFromS3: vi.fn(async () => Buffer.from("fake-pdf-bytes")),
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  headS3Object: s3Mocks.headS3Object,
  uploadToS3: s3Mocks.uploadToS3,
  downloadFromS3: s3Mocks.downloadFromS3,
}));
const rasterMocks = vi.hoisted(() => ({
  rasterizePage: vi.fn(async () => Buffer.alloc(32)),
  getPdfPageCount: vi.fn(async () => 2),
}));
vi.mock("@/lib/pdf-rasterize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rasterizePage: rasterMocks.rasterizePage,
  getPdfPageCount: rasterMocks.getPdfPageCount,
}));
const textractMocks = vi.hoisted(() => ({ analyzePageImageWithFallback: vi.fn(async () => ({ lines: [], words: [] })) }));
vi.mock("@/lib/textract", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  analyzePageImageWithFallback: textractMocks.analyzePageImageWithFallback,
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: vi.fn(async () => ({ keynotes: [] as unknown[], warnings: [] as string[] })),
}));
const censusMocks = vi.hoisted(() => ({ runPdfChannelsOnBuffer: vi.fn() }));
vi.mock("@/lib/pdf-channels/runner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runPdfChannelsOnBuffer: censusMocks.runPdfChannelsOnBuffer,
}));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { processProject } from "@/lib/processing";
import type { PdfChannelsResult } from "@/lib/pdf-channels";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const census: PdfChannelsResult = {
  status: "ok", v: 1, pageCount: 2, ocgLayers: 3, producer: "gen", creator: null, encrypted: false, truncated: false, seconds: 0.2,
  pages: [
    { pageNumber: 1, kind: "vector", widthPt: 2592, heightPt: 1728, rotation: 0, textChars: 10, textWords: 2, fonts: 1, images: 0, fullPageImage: false, vectorPaths: 999, formXObjects: 0, annots: 0, links: 0, ms: 5 },
    { pageNumber: 2, error: "boom", ms: 1 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)("processProject — channel census", () => {
  it("census once with the downloaded PDF; page 1 gets pageIntelligence.channels, a failed census page gets none; summary survives project analysis", async () => {
    censusMocks.runPdfChannelsOnBuffer.mockResolvedValue(census);
    const { project } = await createWorld();

    await processProject(project.id, assertProjectWritable(project));

    expect(censusMocks.runPdfChannelsOnBuffer).toHaveBeenCalledTimes(1);
    expect(censusMocks.runPdfChannelsOnBuffer.mock.calls[0][0].toString()).toBe("fake-pdf-bytes");
    const rows = await db.select({ n: pages.pageNumber, pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id)).orderBy(pages.pageNumber);
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    expect((rows[0].pi as Record<string, unknown>).channels).toEqual({
      v: 1, kind: "vector", textChars: 10, textWords: 2, fonts: 1, images: 0, fullPageImage: false, vectorPaths: 999,
      formXObjects: 0, annots: 0, links: 0, widthPt: 2592, heightPt: 1728, rotation: 0,
    });
    expect((rows[1].pi as Record<string, unknown> | null)?.channels).toBeUndefined();
    const [proj] = await db.select({ pi: projects.projectIntelligence, status: projects.status }).from(projects).where(eq(projects.id, project.id));
    expect(proj.status).toBe("completed");
    expect((proj.pi as Record<string, unknown>).channels).toMatchObject({
      v: 1, pages: 2, failedPages: 1, kinds: { vector: 1, "text-only": 0, scanned: 0, mixed: 0, blank: 0 },
      textLayerShare: 1, vectorShare: 1, scannedPages: [], ocgLayers: 3, producer: "gen", truncated: false,
    });
  }, 30000);

  it("FAIL-SOFT: a census that throws is one warning; the upload completes and no page carries channels", async () => {
    censusMocks.runPdfChannelsOnBuffer.mockRejectedValue(new Error("pdf_channels.py timed out (60s)"));
    const warn = vi.spyOn(logger, "warn");
    const { project } = await createWorld();

    await processProject(project.id, assertProjectWritable(project));

    const censusWarns = warn.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[census F2]"));
    expect(censusWarns).toHaveLength(1);
    const rows = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.pi as Record<string, unknown> | null)?.channels === undefined)).toBe(true);
    const [proj] = await db.select({ pi: projects.projectIntelligence, status: projects.status }).from(projects).where(eq(projects.id, project.id));
    expect(proj.status).toBe("completed");
    expect((proj.pi as Record<string, unknown> | null)?.channels).toBeUndefined();
    warn.mockRestore();
  }, 30000);
});

describe.skipIf(!dbUp)("processProject — channel census runs beside the page loop [census F2 2026-10-24]", () => {
  it("the census can finish AFTER every page was OCR'd and its records still land (the loop never waited for it)", async () => {
    // Resolves only once both pages reached OCR: with the old await-before-the-loop this deadlocks,
    // the census gives up after 5 s and no page carries channels.
    censusMocks.runPdfChannelsOnBuffer.mockImplementation(
      () =>
        new Promise<PdfChannelsResult>((resolve, reject) => {
          const started = Date.now();
          const tick = setInterval(() => {
            if (textractMocks.analyzePageImageWithFallback.mock.calls.length >= 2) {
              clearInterval(tick);
              resolve(census);
            } else if (Date.now() - started > 5000) {
              clearInterval(tick);
              reject(new Error("the page loop waited for the census"));
            }
          }, 10);
        }),
    );
    const { project } = await createWorld();

    await processProject(project.id, assertProjectWritable(project));

    const rows = await db.select({ n: pages.pageNumber, pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id)).orderBy(pages.pageNumber);
    expect((rows[0].pi as Record<string, unknown>).channels).toMatchObject({ kind: "vector", vectorPaths: 999 });
    const [proj] = await db.select({ pi: projects.projectIntelligence, status: projects.status }).from(projects).where(eq(projects.id, project.id));
    expect(proj.status).toBe("completed");
    expect((proj.pi as Record<string, unknown>).channels).toMatchObject({ pages: 2, failedPages: 1 });
  }, 30000);

  it("a census whose page count differs from Ghostscript's numPages writes the summary but no page record (one warning)", async () => {
    censusMocks.runPdfChannelsOnBuffer.mockResolvedValue({ ...census, pageCount: 3, pages: [...census.pages, { ...census.pages[0], pageNumber: 3 }] });
    const warn = vi.spyOn(logger, "warn");
    const { project } = await createWorld();

    await processProject(project.id, assertProjectWritable(project));

    const rows = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.pi as Record<string, unknown> | null)?.channels === undefined)).toBe(true);
    const mismatch = warn.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("census saw 3 pages, the project has 2"));
    expect(mismatch).toHaveLength(1);
    const [proj] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
    expect((proj.pi as Record<string, unknown>).channels).toMatchObject({ pages: 3 });
    warn.mockRestore();
  }, 30000);
});
