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
// Mocks: true edges only — @/lib/s3 (AWS), global fetch (PDF download), pdf-rasterize
// (ghostscript), textract's AWS entrypoint, keynotes (OpenCV/Tesseract spawn). The
// intelligence pipeline (page-analysis, text-region-classifier, heuristic-engine,
// table-classifier, csi-spatial, project-analysis, intelligence-merge) runs REAL against
// the REAL test DB — importOriginal-spread idiom per admin-reprocess.route.test.ts.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

const s3Mocks = vi.hoisted(() => ({
  headS3Object: vi.fn(async () => ({ exists: true, size: 8 })),
  getS3Url: vi.fn(() => "http://s3.test.local/original.pdf"),
  uploadToS3: vi.fn(async () => {}),
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
  warmCloudFrontCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  headS3Object: s3Mocks.headS3Object,
  getS3Url: s3Mocks.getS3Url,
  uploadToS3: s3Mocks.uploadToS3,
  downloadFromS3: s3Mocks.downloadFromS3,
  warmCloudFrontCache: s3Mocks.warmCloudFrontCache,
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
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createPage, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const userParsedRegions = [
  { id: "pr-f4", type: "schedule", bbox: [0.1, 0.1, 0.5, 0.5], data: { rows: 3 } },
];
const staleClassifiedTables = [{ id: "stale-table", kind: "schedule", pageNumber: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  // processProject downloads original.pdf via plain fetch(getS3Url(...)) — stub the
  // network edge (db is pg/TCP, unaffected).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
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

    const result = await processProject(project.id);
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

    await processProject(project.id);

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.textractData).toEqual({ lines: [], words: [] }); // update DID run
    expect(row.pageIntelligence).toEqual({ classifiedTables: staleClassifiedTables }); // untouched, NOT null
  }, 30000);

  it("INSERT branch unchanged: fresh page rows get the fresh-computed PI (null when nothing detected)", async () => {
    const { project } = await createWorld();
    rasterMocks.getPdfPageCount.mockResolvedValue(1);

    await processProject(project.id);

    const [row] = await db
      .select()
      .from(pages)
      .where(eq(pages.projectId, project.id));
    expect(row.pageNumber).toBe(1);
    expect(row.textractData).toEqual({ lines: [], words: [] });
    expect(row.pageIntelligence).toBeNull(); // insert semantics byte-identical
  }, 30000);
});
