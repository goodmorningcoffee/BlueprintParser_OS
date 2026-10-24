// @vitest-environment node
// [census F2 2026-10-24] The Reprocess "PDF channels" scope against the real test DB with the two
// true edges mocked (S3 download of original.pdf, the python census). Pins: the PDF key is derived
// from the project's dataUrl; each page ROW the census read gets pageIntelligence.channels by jsonb
// merge (user-owned, computed and unknown keys untouched; NULL → {channels}); a row the census could
// not read is left exactly as it was, counted skipped, with one warning; projectIntelligence.channels
// is merged without touching other keys; a project that throws is one `error` line and the stream
// still gets `done`; a non-root caller gets one error line and nothing runs.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const s3Mocks = vi.hoisted(() => ({ downloadFromS3: vi.fn(async (_key: string) => Buffer.from("pdf-bytes")) }));
vi.mock("@/lib/s3", async (importOriginal) => ({ ...(await importOriginal<object>()), downloadFromS3: s3Mocks.downloadFromS3 }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import type { PdfChannelsResult } from "@/lib/pdf-channels";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { CHANNELS_ROOT_ONLY_MESSAGE, reprocessChannelsScope } from "@/server/services/reprocess-channels";
import type { ReprocessStream } from "@/server/services/reprocess-stream";
import { createPage, createProject, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

function fakeStream() {
  const events: Record<string, unknown>[] = [];
  const stream: ReprocessStream = {
    send: (e) => {
      events.push(e);
    },
    debug: () => {},
    isClosed: () => false,
    close: () => {},
    debugEnabled: false,
  };
  return { stream, events };
}

const pageOk = (pageNumber: number, kind: "vector" | "scanned") => ({
  pageNumber, kind, widthPt: 612, heightPt: 792, rotation: 0, textChars: kind === "vector" ? 50 : 0, textWords: 9, fonts: 1,
  images: kind === "scanned" ? 1 : 0, fullPageImage: kind === "scanned", vectorPaths: kind === "vector" ? 400 : 0, formXObjects: 0, annots: 0, links: 0, ms: 3,
});
const result = (pages: PdfChannelsResult["pages"]): PdfChannelsResult => ({
  status: "ok", v: 1, pageCount: pages.length, ocgLayers: 0, producer: "gen", creator: null, encrypted: false, truncated: false, seconds: 0.1, pages,
});
const stored = (p: ReturnType<typeof pageOk>) => {
  const { pageNumber: _n, ms: _ms, ...rest } = p;
  return { v: 1, ...rest };
};
const intelligenceOf = async (pageId: number) =>
  (await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId)))[0].pi as Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)("reprocessChannelsScope", () => {
  it("censuses original.pdf, merges each readable page's record, skips the unreadable one, merges the project summary", async () => {
    const { project } = await createWorld({ numPages: 3 });
    await db.update(projects).set({ projectIntelligence: { yoloTags: ["keep"], channels: { v: 0 } } as never }).where(eq(projects.id, project.id));
    const p1 = await createPage(project.id, 1, { pageIntelligence: { parsedRegions: [{ id: "r1" }], classifiedTables: [{ x: 1 }], futureKey: true } as never });
    const p2 = await createPage(project.id, 2); // NULL intelligence
    const p3 = await createPage(project.id, 3, { pageIntelligence: { parsedRegions: [{ id: "keep" }] } as never });
    const run = vi.fn(async (_pdf: Buffer) => result([pageOk(1, "vector"), pageOk(2, "scanned"), { pageNumber: 3, error: "boom" }]));
    const { stream, events } = fakeStream();

    const c = await reprocessChannelsScope({
      projects: [project],
      withReprocessLease: (id, op) => op(assertProjectWritable({ ...project, id })),
      stream,
      isRootAdmin: true,
      census: { run, now: () => new Date("2026-10-24T00:00:00Z") },
    });

    expect(c).toEqual({ updated: 2, skipped: 1, total: 3 });
    expect(s3Mocks.downloadFromS3.mock.calls.map(([k]) => k)).toEqual([`${project.dataUrl}/original.pdf`]);
    expect(run.mock.calls[0][0].toString()).toBe("pdf-bytes");
    expect(await intelligenceOf(p1.id)).toEqual({
      parsedRegions: [{ id: "r1" }], classifiedTables: [{ x: 1 }], futureKey: true, channels: stored(pageOk(1, "vector")),
    });
    expect(await intelligenceOf(p2.id)).toEqual({ channels: stored(pageOk(2, "scanned")) });
    expect(await intelligenceOf(p3.id)).toEqual({ parsedRegions: [{ id: "keep" }] });
    const [proj] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
    expect(proj.pi).toEqual({
      yoloTags: ["keep"],
      channels: {
        v: 1, computedAt: "2026-10-24T00:00:00.000Z", pages: 3, failedPages: 1,
        kinds: { vector: 1, "text-only": 0, scanned: 1, mixed: 0, blank: 0 },
        textLayerShare: 0.5, vectorShare: 0.5, scannedPages: [2], ocgLayers: 0, producer: "gen", truncated: false,
      },
    });
    expect(events[0]).toEqual({ type: "project", name: project.name, pages: 3 });
    expect(events.filter((e) => e.type === "warning")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", updated: 2, skipped: 1, total: 3 });
  });

  it("a project without rows is skipped silently; one whose census throws is one error line and the run continues to done", async () => {
    const { company, user, project: good } = await createWorld({ numPages: 1 });
    const empty = await createProject(company.id, user.id, { numPages: 2 });
    const broken = await createProject(company.id, user.id, { numPages: 1 });
    await createPage(good.id, 1);
    const bp = await createPage(broken.id, 1, { pageIntelligence: { keep: 1 } as never });
    const run = vi.fn(async (_pdf: Buffer) => {
      if (run.mock.calls.length === 1) throw new Error("pdf_channels.py timed out (60s)");
      return result([pageOk(1, "vector")]);
    });
    const { stream, events } = fakeStream();

    const c = await reprocessChannelsScope({
      projects: [broken, empty, good],
      withReprocessLease: (id, op) => op(assertProjectWritable({ ...good, id })),
      stream,
      isRootAdmin: true,
      census: { run },
    });

    expect(c).toEqual({ updated: 1, skipped: 0, total: 1 });
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", project: broken.name, error: "pdf_channels.py timed out (60s)" }]);
    expect(await intelligenceOf(bp.id)).toEqual({ keep: 1 });
    expect(events.at(-1)).toEqual({ type: "done", updated: 1, skipped: 0, total: 1 });
  });

  it("non-root: one error line, done, nothing downloaded or censused", async () => {
    const { project } = await createWorld({ numPages: 1 });
    await createPage(project.id, 1);
    const run = vi.fn();
    const { stream, events } = fakeStream();
    const c = await reprocessChannelsScope({
      projects: [project],
      withReprocessLease: (id, op) => op(assertProjectWritable({ ...project, id })),
      stream,
      isRootAdmin: false,
      census: { run },
    });
    expect(c).toEqual({ updated: 0, skipped: 0, total: 0 });
    expect(events).toEqual([{ type: "error", error: CHANNELS_ROOT_ONLY_MESSAGE }, { type: "done", updated: 0, skipped: 0, total: 0 }]);
    expect(run).not.toHaveBeenCalled();
    expect(s3Mocks.downloadFromS3).not.toHaveBeenCalled();
  });
});
