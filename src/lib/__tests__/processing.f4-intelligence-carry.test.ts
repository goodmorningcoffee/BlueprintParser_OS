// @vitest-environment node
// [bugfix jul9 F4 P2-phaseB, owner-sanctioned] SURVIVAL PIN for processProject's page
// UPDATE branch (processing.ts ~:468) — the page-level twin of reprocess bug G3 (and of
// the project-level H6). The upload pipeline builds pageIntelligence FRESH each run and
// the UPDATE branch used to write it WHOLESALE — even null when nothing was detected —
// silently wiping user-owned keys (parsedRegions = hours of wizard work; unknown future
// keys) on any re-run. Reachability: /api/processing/dev (processingDev — dev-gated, NO
// status guard) and the SFN worker retry (scripts/process-worker.ts) both re-run
// processProject over projects whose page rows already exist.
//
// Reachability nuance pinned here: the loop's skip-guard (processing.ts ~:275) early-
// returns pages that already HAVE textractData — so the UPDATE branch fires exactly for
// rows WITHOUT textractData (e.g. prior error rows, half-ingested projects) that have
// since accumulated user pageIntelligence via the parse wizards. The victim fixtures
// therefore seed pageIntelligence WITHOUT textractData; a with-textractData page rides
// along to pin the skip-guard (untouched = trivially safe).
//
// Written RED-FIRST (H6 idiom): pre-fix the UPDATE wrote pageIntelligence: null over
// {parsedRegions, someFutureKey, classifiedTables} — parsedRegions/someFutureKey
// assertions failed. Fix: carryNonComputedIntelligence(existing) + fresh-computed
// overlay, identical semantics to services/reprocess.ts:524; merged-empty → OMIT the
// column from the update (never null-out user data on update).
//
// Mocks: true edges only — @/lib/s3 (private task-role reads/writes), pdf-rasterize
// (ghostscript), textract's AWS entrypoint, keynotes (OpenCV/Tesseract spawn). The
// intelligence pipeline (page-analysis, text-region-classifier, heuristic-engine,
// table-classifier, csi-spatial, project-analysis, intelligence-merge) runs REAL against
// the REAL test DB — importOriginal-spread idiom per admin-reprocess.route.test.ts.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

const s3Mocks = vi.hoisted(() => ({
  headS3Object: vi.fn(async () => ({ exists: true, size: 8 })),
  uploadToS3: vi.fn(async () => {}),
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  headS3Object: s3Mocks.headS3Object,
  uploadToS3: s3Mocks.uploadToS3,
  downloadFromS3: s3Mocks.downloadFromS3,
}));

const rasterMocks = vi.hoisted(() => ({
  // 32 zero bytes: readUInt32BE(16/20) → 0x0 dims → under the Textract px limit,
  // no re-rasterize branch.
  rasterizePage: vi.fn(async () => Buffer.alloc(32)),
  getPdfPageCount: vi.fn(async () => 1),
}));
vi.mock("@/lib/pdf-rasterize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rasterizePage: rasterMocks.rasterizePage,
  getPdfPageCount: rasterMocks.getPdfPageCount,
}));

const textractMocks = vi.hoisted(() => ({
  // Empty-but-truthy OCR result: the run computes NOTHING fresh, so pre-fix the
  // UPDATE branch wrote pageIntelligence = null — the maximal wipe.
  analyzePageImageWithFallback: vi.fn(async () => ({ lines: [], words: [] })),
}));
vi.mock("@/lib/textract", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  analyzePageImageWithFallback: textractMocks.analyzePageImageWithFallback,
}));

const keynotesMocks = vi.hoisted(() => ({
  extractKeynotes: vi.fn(async () => ({ keynotes: [] as unknown[], warnings: [] as string[] })),
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: keynotesMocks.extractKeynotes,
}));

import { processProject } from "@/lib/processing";
import { computePageZones } from "@/lib/page-zones";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { createPage, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [refactor jul23 P4.1 U7] Only the observe module's entries — logger.warn is shared.
const shapeRegistryWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).startsWith("[shape-registry]"),
  );

const userParsedRegions = [
  { id: "pr-f4", type: "schedule", bbox: [0.1, 0.1, 0.5, 0.5], data: { rows: 3 } },
];
const staleClassifiedTables = [{ id: "stale-table", kind: "schedule", pageNumber: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!dbUp)("processProject — F4 pageIntelligence carry (UPDATE branch)", () => {
  it("★F4 pin: user/unknown PI keys survive a re-run; stale computed keys refresh; skip-guard page untouched", async () => {
    const { project } = await createWorld();
    // Victim: page row WITHOUT textractData (prior error row / half-ingest) that has
    // since accumulated user + unknown + stale-computed pageIntelligence keys.
    const victim = await createPage(project.id, 1, {
      error: "textract exploded on the first run",
      pageIntelligence: {
        parsedRegions: userParsedRegions,
        someFutureKey: { keep: "me" },
        classifiedTables: staleClassifiedTables, // computed → must NOT survive as-is
      } as never,
    });
    // Rider: page WITH textractData → skip-guard early-return, byte-untouched.
    const rider = await createPage(project.id, 2, {
      textractData: { lines: [], words: [] } as never,
      pageIntelligence: { parsedRegions: userParsedRegions } as never,
    });
    rasterMocks.getPdfPageCount.mockResolvedValue(2);

    const result = await processProject(project.id, assertProjectWritable(project));
    expect(result.pageErrors).toBe(0);

    const [victimRow] = await db.select().from(pages).where(eq(pages.id, victim.id));
    // UPDATE branch actually ran (not skipped): textractData now present.
    expect(victimRow.textractData).toEqual({ lines: [], words: [] });
    const pi = victimRow.pageIntelligence as Record<string, unknown> | null;
    // ★ the F4 red-line: pre-fix this was NULL (wholesale wipe).
    expect(pi).not.toBeNull();
    expect(pi!.parsedRegions).toEqual(userParsedRegions); // user key survives
    expect(pi!.someFutureKey).toEqual({ keep: "me" }); // unknown key survives
    // stale computed key refreshed: nothing detected this run → dropped, not carried
    expect(pi!.classifiedTables).toBeUndefined();
    // exact key-set pin (empty OCR computes nothing fresh — observed 2026-07-09)
    expect(Object.keys(pi!).sort()).toEqual(["parsedRegions", "someFutureKey"]);

    // skip-guard rider: byte-identical PI, rawText never written.
    const [riderRow] = await db.select().from(pages).where(eq(pages.id, rider.id));
    expect(riderRow.pageIntelligence).toEqual({ parsedRegions: userParsedRegions });
    expect(riderRow.rawText).toBeNull();
  }, 30000);

  it("merged-empty → pageIntelligence OMITTED from the update (never nulled), other columns still refresh", async () => {
    const { project } = await createWorld();
    // Only computed keys exist: carry = {}, fresh = {} → merged has zero keys.
    // Owner-sanctioned semantics: OMIT the column (leave it as-is) rather than
    // write null on an update — the column value must be byte-identical after.
    const page = await createPage(project.id, 1, {
      pageIntelligence: { classifiedTables: staleClassifiedTables } as never,
    });
    rasterMocks.getPdfPageCount.mockResolvedValue(1);

    await processProject(project.id, assertProjectWritable(project));

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.textractData).toEqual({ lines: [], words: [] }); // update DID run
    expect(row.pageIntelligence).toEqual({ classifiedTables: staleClassifiedTables }); // untouched, NOT null
  }, 30000);

  it("INSERT branch unchanged: fresh page rows get the fresh-computed PI (null when nothing detected)", async () => {
    const { project } = await createWorld();
    rasterMocks.getPdfPageCount.mockResolvedValue(1);

    await processProject(project.id, assertProjectWritable(project));

    const [row] = await db
      .select()
      .from(pages)
      .where(eq(pages.projectId, project.id));
    expect(row.pageNumber).toBe(1);
    expect(row.textractData).toEqual({ lines: [], words: [] });
    expect(row.pageIntelligence).toBeNull(); // insert semantics byte-identical
  }, 30000);

  // [refactor jul23 P4.1 U7-A] FREEZE-FIRST: fire the processing.ts:504 shape-parse sink
  // for the FIRST time under test. Every prior test mocks extractKeynotes to {keynotes:[]}
  // so the sink (guarded by `result.keynotes.length > 0`) never ran — this pins the
  // PRE-wiring persisted shape (row cols + EXACT data blob + pages.keynotes mirror). U7's
  // log-mode observe never touches persistence, so this stays green AFTER the wiring lands.
  it("★U7-A pin: non-empty extractKeynotes fires the shape-parse sink — inserted row + EXACT data blob + pages.keynotes mirror", async () => {
    const { project } = await createWorld();
    rasterMocks.getPdfPageCount.mockResolvedValue(1);
    // One realistic keynote (the 300-DPI display-buffer shape-parse result).
    const keynote = {
      shape: "circle",
      text: "K1",
      bbox: [0.1, 0.1, 0.2, 0.2],
      contour: [
        [0.1, 0.1],
        [0.2, 0.2],
      ],
    };
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({
      keynotes: [keynote],
      warnings: [],
    });

    await processProject(project.id, assertProjectWritable(project));

    // (1) exactly one shape-parse annotation row; geometry + threshold + source pinned.
    const rows = await db
      .select()
      .from(annotations)
      .where(eq(annotations.projectId, project.id));
    const shapeRows = rows.filter((r) => r.source === "shape-parse");
    expect(shapeRows).toHaveLength(1);
    const [row] = shapeRows;
    expect(row.name).toBe("circle");
    expect(row.minX).toBeCloseTo(0.1, 5);
    expect(row.minY).toBeCloseTo(0.1, 5);
    expect(row.maxX).toBeCloseTo(0.2, 5);
    expect(row.maxY).toBeCloseTo(0.2, 5);
    expect(row.pageNumber).toBe(1);
    expect(row.threshold).toBe(0.9);
    expect(row.source).toBe("shape-parse");
    // (2) EXACT data blob — deep-equal + sorted key-set (no extra/missing keys, jsonb exact).
    expect(row.data).toEqual({
      modelName: "shape-parse",
      shapeType: "circle",
      text: "K1",
      contour: [
        [0.1, 0.1],
        [0.2, 0.2],
      ],
      confidence: 0.9,
    });
    expect(Object.keys(row.data as object).sort()).toEqual([
      "confidence",
      "contour",
      "modelName",
      "shapeType",
      "text",
    ]);
    // (3) pages.keynotes mirror carries the RAW keynote (written via pageData — a separate
    // concern from the annotations insert; recon documents the desync hazard, out of scope).
    const [pageRow] = await db
      .select({ keynotes: pages.keynotes })
      .from(pages)
      .where(eq(pages.projectId, project.id));
    expect(pageRow.keynotes).toEqual([keynote]);
  }, 30000);
});

// [refactor jul23 P4.1 U7] Warn-net for the processing.ts shape-parse observe wiring
// (rides commit U7-B). Log-mode contract (spec Verdict 2 / RD-U7d): a valid blob warns
// zero times; a malformed blob STILL persists byte-identical (log+skip, gate:false) and
// emits exactly ONE aggregated [shape-registry] warn carrying sink+kind. Uses a scoped
// logger spy restored per-test (a blanket restoreAllMocks would nuke the vi.hoisted mock
// defaults this file relies on — see keynotesMocks etc.).
describe.skipIf(!dbUp)("processProject — U7 shape-parse observe warn-net [P4.1 U7]", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn");
  });
  afterEach(() => warnSpy.mockRestore());

  it("valid keynote → shape-parse row persists with ZERO shape-registry warns", async () => {
    const { project } = await createWorld();
    rasterMocks.getPdfPageCount.mockResolvedValue(1);
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({
      keynotes: [
        { shape: "circle", text: "K1", bbox: [0.1, 0.1, 0.2, 0.2], contour: [[0.1, 0.1]] },
      ],
      warnings: [],
    });

    await processProject(project.id, assertProjectWritable(project));

    const shapeRows = (
      await db.select().from(annotations).where(eq(annotations.projectId, project.id))
    ).filter((r) => r.source === "shape-parse");
    expect(shapeRows).toHaveLength(1);
    expect(shapeRegistryWarns(warnSpy)).toHaveLength(0);
  }, 30000);

  it("malformed keynote (shapeType number) → row STILL persists (log-only) + exactly ONE warn {sink:processing.shapeParse, kind:shape-parse}", async () => {
    const { project } = await createWorld();
    rasterMocks.getPdfPageCount.mockResolvedValue(1);
    // shapeType comes from k.shape; a number violates zShapeParseData.shapeType (string).
    // k.shape also feeds the varchar `name` col (coerced to "9") so the row still inserts.
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({
      keynotes: [
        { shape: 9, text: "K1", bbox: [0.1, 0.1, 0.2, 0.2], contour: [[0.1, 0.1]] } as never,
      ],
      warnings: [],
    });

    await processProject(project.id, assertProjectWritable(project));

    const shapeRows = (
      await db.select().from(annotations).where(eq(annotations.projectId, project.id))
    ).filter((r) => r.source === "shape-parse");
    expect(shapeRows).toHaveLength(1); // ← log-only: v0 write never blocked
    expect((shapeRows[0].data as Record<string, unknown>).shapeType).toBe(9); // persisted, violations and all
    const calls = shapeRegistryWarns(warnSpy);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("processing.shapeParse");
    expect(ctx.kind).toBe("shape-parse");
  }, 30000);
});

// [zones T2 2026-10-24] A processing re-run must not undo the YOLO step's zones: `pageZones`
// is a computed key (cleared by carryNonComputedIntelligence), so the UPDATE branch re-adds the
// stored value AND feeds it to the title-block consumers — otherwise the same page's drawing
// number / text regions flip between the detected title block and the fixed corner depending
// on which job ran last (verifier MED-2).
describe.skipIf(!dbUp)("processProject — stored pageZones survive a re-run and steer the title-block consumers", () => {
  it("detector zones persist through the UPDATE merge and the drawing number is read INSIDE the detected block", async () => {
    const { project } = await createWorld();
    const pageZones = computePageZones([
      { name: "title_block", minX: 0, minY: 0, maxX: 0.4, maxY: 0.15, confidence: 0.9, modelName: "yolo_medium" },
    ]);
    const victim = await createPage(project.id, 1, {
      error: "first run died",
      pageIntelligence: { parsedRegions: userParsedRegions, pageZones } as never,
    });
    // Sheet number in a TOP-LEFT title block; a cross-reference sits in the fixed bottom-right corner.
    const W = (text: string, x: number, y: number) => ({ text, confidence: 95, bbox: [x, y, 0.05, 0.02] });
    textractMocks.analyzePageImageWithFallback.mockResolvedValueOnce({
      lines: [],
      words: [W("SHEET", 0.05, 0.05), W("NO.", 0.11, 0.05), W("A-201", 0.15, 0.05), W("SEE", 0.55, 0.8), W("E-345", 0.61, 0.8)],
    } as never);
    rasterMocks.getPdfPageCount.mockResolvedValue(1);

    const result = await processProject(project.id, assertProjectWritable(project));
    expect(result.pageErrors).toBe(0);

    const [row] = await db.select().from(pages).where(eq(pages.id, victim.id));
    const pi = row.pageIntelligence as Record<string, unknown>;
    expect(pi.pageZones).toEqual(pageZones); // survived the computed-key clear
    expect(pi.parsedRegions).toEqual(userParsedRegions);
    expect(row.drawingNumber).toBe("A-201"); // legacy fixed corner would have answered "E-345"
  }, 30000);

  it("no stored zones ⇒ legacy fixed-corner search, and no pageZones key is invented", async () => {
    const { project } = await createWorld();
    const victim = await createPage(project.id, 1, { error: "first run died", pageIntelligence: { parsedRegions: userParsedRegions } as never });
    const W = (text: string, x: number, y: number) => ({ text, confidence: 95, bbox: [x, y, 0.05, 0.02] });
    textractMocks.analyzePageImageWithFallback.mockResolvedValueOnce({
      lines: [],
      words: [W("SHEET", 0.05, 0.05), W("NO.", 0.11, 0.05), W("A-201", 0.15, 0.05), W("SEE", 0.55, 0.8), W("E-345", 0.61, 0.8)],
    } as never);
    rasterMocks.getPdfPageCount.mockResolvedValue(1);

    await processProject(project.id, assertProjectWritable(project));

    const [row] = await db.select().from(pages).where(eq(pages.id, victim.id));
    expect((row.pageIntelligence as Record<string, unknown>).pageZones).toBeUndefined();
    expect(row.drawingNumber).toBe("E-345");
  }, 30000);
});

// [fix 2026-10-22] Upload shape parse REPLACES the page's shape-parse rows (a retry/rerun of a
// page used to append a second copy); other sources and other pages are untouched.
describe.skipIf(!dbUp)("processProject — shape-parse rerun replaces, never appends", () => {
  it("a re-processed page ends with exactly the new shape-parse rows", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1, { error: "first run died after shape parse" });
    const stale = (pageNumber: number, source: string) => ({
      name: "circle", minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2, pageNumber, threshold: 0.9,
      source, data: { modelName: "shape-parse", shapeType: "circle", text: "OLD" }, projectId: project.id,
    });
    await db.insert(annotations).values([
      stale(1, "shape-parse"), stale(1, "shape-parse"), stale(1, "user"), stale(2, "shape-parse"),
    ] as never);
    rasterMocks.getPdfPageCount.mockResolvedValue(1);
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({
      keynotes: [{ shape: "circle", text: "NEW", bbox: [0.3, 0.3, 0.4, 0.4], contour: [[0.3, 0.3]] }],
      warnings: [],
    });

    await processProject(project.id, assertProjectWritable(project));

    const rows = await db.select().from(annotations).where(eq(annotations.projectId, project.id));
    const page1Shapes = rows.filter((r) => r.pageNumber === 1 && r.source === "shape-parse");
    expect(page1Shapes.map((r) => (r.data as Record<string, unknown>).text)).toEqual(["NEW"]);
    expect(rows.filter((r) => r.source === "user")).toHaveLength(1);
    expect(rows.filter((r) => r.pageNumber === 2 && r.source === "shape-parse")).toHaveLength(1);
  }, 30000);
});
