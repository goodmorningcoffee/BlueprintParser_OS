// @vitest-environment node
// [refactor jul8 S062 reprocess-freeze] Characterization net for POST /api/admin/reprocess
// BEFORE the defineRoute fold (the DEAD-LAST P1.5 solo). Cases 1-17 from
// refactor_html_memories/SOLOS_RECON_REPROCESS.md (wf_f25412e2-9bd) — this file pins the
// legacy route byte-for-byte; the fold must keep every case green (auth literals flip to
// the envelope per sanctioned-A only).
//
// Owner decisions locked 2026-07-08 (this session):
//   §A  shell auth:"admin" — verified byte-identical "Unauthorized"/"Admin only" messages.
//   §E-a PRESERVE the body swallow: no shell body parse (rawBody:true at fold); malformed/
//        absent/non-object body → process ALL company projects. Auth stays BEFORE parse,
//        so signed-out+malformed stays 401 (NO PH-5b flip — pinned in "§E-a" cases below).
//   §B-thumbnails PRESERVE the in-stream err.message verbatim — it is 200-stream domain
//        data parsed by `type`, not an HTTP error envelope (pinned via "kaboom-outer").
//
// ★H6 FREEZE PIN (case 4): W8 project-level merge is a BLIND spread — keys present in
// analyzeProject's output win; EVERY other existing projectIntelligence key survives
// (yoloTags, classCsiOverrides, unknown/future keys). The pin is the spread semantics,
// NOT a key-list refresh (the dead PROJECT_REPROCESS_COMPUTED_KEYS const was deleted
// jul9 P2-A S3). Wlib (computeProjectSummaries) re-reads AFTER W8 and must also
// preserve those keys.
// [refactor jul9 P2-A S2] projectIntelligence.pageCount purged (was analyzeProject's
// only unconditionally-emitted key): "was processed" witnesses swapped to the
// stale-disciplines REFRESH (seed a stale value → W8 lays over/drops it) + Wlib's
// `summaries` presence. Owner-sanctioned same-commit pin swap, P2_STATE 2026-07-09.
//
// Mocks: @/lib/s3, @/lib/pdf-rasterize, @/lib/lambda-cv, @/lib/keynotes,
// @/lib/text-region-classifier-debug (side-effectful edges only). The intelligence/full
// pipelines (page-analysis, csi-detect, text-annotations, intelligence-merge,
// project-analysis) run REAL — that's the behavior being frozen.
// NDJSON: drain via res.text(), NEVER readJson() (G3 idiom — work happens in the stream).
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
  uploadToS3: vi.fn(async () => {}),
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadFromS3: s3Mocks.downloadFromS3,
  uploadToS3: s3Mocks.uploadToS3,
}));

const rasterMocks = vi.hoisted(() => ({
  rasterizePage: vi.fn(async () => Buffer.from("fake-png")),
  getPdfPageCount: vi.fn(async () => 1),
}));
vi.mock("@/lib/pdf-rasterize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rasterizePage: rasterMocks.rasterizePage,
  getPdfPageCount: rasterMocks.getPdfPageCount,
}));

const lambdaMocks = vi.hoisted(() => ({
  isLambdaCvEnabled: vi.fn(() => false),
  fanOutShapeParse: vi.fn(),
}));
vi.mock("@/lib/lambda-cv", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLambdaCvEnabled: lambdaMocks.isLambdaCvEnabled,
  fanOutShapeParse: lambdaMocks.fanOutShapeParse,
}));

const keynotesMocks = vi.hoisted(() => ({
  extractKeynotes: vi.fn(async () => ({ keynotes: [] as any[], warnings: [] as string[] })),
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: keynotesMocks.extractKeynotes,
}));

const debugMocks = vi.hoisted(() => ({
  writeClassifierDebugBundle: vi.fn(async () => {}),
}));
vi.mock("@/lib/text-region-classifier-debug", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeClassifierDebugBundle: debugMocks.writeClassifierDebugBundle,
}));

// [refactor P1-review jul8] L3-4 gap: the auto-table detector is dynamically imported and
// gated on pipelineConfig.autoDetect.tables (default OFF) — mock it so the default-off pin
// can assert not-called (and a future default-flip fails loudly).
const autoTableMocks = vi.hoisted(() => ({
  detectAutoTables: vi.fn(() => [] as any[]),
}));
vi.mock("@/lib/auto-detect/auto-table-detector", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detectAutoTables: autoTableMocks.detectAutoTables,
}));

import { POST } from "@/app/api/admin/reprocess/route";
import { POST as demoPOST } from "@/app/api/admin/demo/route";
import { db } from "@/lib/db";
import { annotations, pages, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  ageProjectForPublication,
  annotationsFor,
  asUser,
  createPage,
  createProject,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [refactor jul23 P4.1 U7] Only the observe module's entries — logger.warn is shared.
const shapeRegistryWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).startsWith("[shape-registry]"),
  );

/** Drain the NDJSON stream fully (the work happens inside it), parse every line. */
async function drain(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Request with a RAW (possibly non-JSON) body — makeReq only builds valid JSON. */
function rawBodyReq(path: string, raw: string): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

/** Minimal-but-real textract payload: route requires a truthy value or skips the page. */
const emptyTextract = { lines: [], words: [] } as any;

/** ≥5 lines with words — classifyTextRegions early-returns below CLASSIFIER_MIN_REGION_WORDS
 *  line-features, and the debug bundle only emits past that gate (case 14 needs it). */
const richTextract = (() => {
  const mkWord = (text: string, x: number, y: number) => ({
    text,
    confidence: 99,
    bbox: [x, y, 0.05, 0.01] as [number, number, number, number],
  });
  const lines = Array.from({ length: 6 }, (_, i) => {
    const y = 0.1 + i * 0.05;
    const words = [mkWord(`WORD${i}A`, 0.1, y), mkWord(`WORD${i}B`, 0.16, y)];
    return {
      text: words.map((w) => w.text).join(" "),
      confidence: 99,
      words,
      bbox: [0.1, y, 0.12, 0.01] as [number, number, number, number],
    };
  });
  return { lines, words: lines.flatMap((l) => l.words) } as any;
})();

beforeEach(() => {
  // clear call history; keep the default implementations set in vi.hoisted above
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)("POST /api/admin/reprocess — freeze", () => {
  // ── auth literals (cases 1-2; flipped flat→envelope AT FOLD per sanctioned-A —
  //    status + message byte-verbatim, only the envelope shape changed) ─────────
  it("signed-out → 401 UNAUTHORIZED/'Unauthorized' (auth runs BEFORE anything else)", async () => {
    signedOut();
    const res = await POST(makeReq("/api/admin/reprocess", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
  });

  it("non-admin member → 403 FORBIDDEN/'Admin only'", async () => {
    const { company } = await createWorld();
    const member = await createUser(company.id, { role: "user" });
    asUser(member);
    const res = await POST(makeReq("/api/admin/reprocess", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "Admin only" } });
  });

  // ── stream envelope + intelligence scope (cases 3-4, 14-16) ─────────────────
  it("intelligence, no body: 200 NDJSON stream, start→…→done, chunked headers", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: emptyTextract, rawText: "" });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    expect(res.status).toBe(200);
    // viewer-perf / streaming pins — must survive the fold via Response-passthrough
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("transfer-encoding")).toBe("chunked");

    const lines = await drain(res);
    expect(lines[0]).toEqual({ type: "start", projects: 1 });
    const done = lines[lines.length - 1];
    expect(done.type).toBe("done");
    expect(Object.keys(done).sort()).toEqual(["skipped", "total", "type", "updated"]);
    // intelligence/full progress lines OMIT `skipped` (counter-shape pin, case 15)
    for (const l of lines.filter((l) => l.type === "progress")) {
      expect(l).not.toHaveProperty("skipped");
      expect(Object.keys(l).sort()).toEqual(["project", "total", "type", "updated"]);
    }
    expect(lines.some((l) => l.type === "project-analysis")).toBe(true);
    expect(lines.some((l) => l.type === "project-summaries")).toBe(true);
  }, 30000);

  it("★H6 pin: project-PI blind spread — analyzeProject keys win, ALL other keys survive W8 AND Wlib", async () => {
    const seededPi = {
      yoloTags: { "03 30 00": ["tag-a"] },
      classCsiOverrides: { text_box: "09 91 23" },
      futureKey: { keep: "me" },
      disciplines: ["stale-discipline"],
    };
    const { company, project } = await createWorld({ projectIntelligence: seededPi as any });
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: emptyTextract, rawText: "" });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    const lines = await drain(res); // full drain = past project-summaries (Wlib runs AFTER W8)
    expect(lines.some((l) => l.type === "project-summaries")).toBe(true);

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    const pi = row.projectIntelligence as Record<string, any>;
    // survivors: every key analyzeProject does NOT emit
    expect(pi.yoloTags).toEqual(seededPi.yoloTags);
    expect(pi.classCsiOverrides).toEqual(seededPi.classCsiOverrides);
    expect(pi.futureKey).toEqual(seededPi.futureKey);
    // analyzeProject keys WIN (blind spread): the stale disciplines is laid over by
    // the fresh value — empty this run → undefined → dropped by the jsonb write, so
    // the key must be GONE (also the "W8 ran" witness; pageCount purged jul9 P2-A S2)
    expect(pi).not.toHaveProperty("disciplines");
    // Wlib (computeProjectSummaries) layered `summaries` AFTER W8 without clobbering
    expect(pi.summaries).toBeDefined();
    expect(typeof row.projectSummary).toBe("string");
  }, 30000);

  it("intelligence + debug=1 fires the classifier debug bundle S3 write (case 14)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: richTextract, rawText: "" });

    asUser(admin);
    const res = await POST(
      makeReq("/api/admin/reprocess?scope=intelligence&debug=1", { method: "POST" }),
    );
    await drain(res);
    expect(debugMocks.writeClassifierDebugBundle).toHaveBeenCalledWith(
      project.dataUrl,
      1,
      expect.anything(),
    );
  }, 30000);

  // ── P1-review char-gap closers (S062 DETECTOR L3-1/L3-2/L3-4) ────────────────
  it("★L3-1: YOLO-present intelligence — heatmap/composite/ensemble path runs and user keys still survive", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const userParsedRegions = [
      { id: "pr-yolo", type: "schedule", bbox: [0.1, 0.1, 0.5, 0.5], data: { rows: 2 } },
    ];
    const page = await createPage(project.id, 1, {
      textractData: richTextract,
      rawText: "GENERAL NOTES",
      pageIntelligence: { parsedRegions: userParsedRegions, someFutureKey: { keep: "me" } } as any,
    });
    // a HEATMAP_CLASSES-member YOLO annotation → yoloByPage non-empty → the composite/
    // heatmap/ensemble sub-branch (dead in every other test) actually executes
    await db.insert(annotations).values({
      name: "text_box", minX: 0.1, minY: 0.1, maxX: 0.4, maxY: 0.3, pageNumber: 1,
      threshold: 0.5, source: "yolo", projectId: project.id,
      data: { confidence: 0.9, modelName: "yolo-test" } as any,
    });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    const lines = await drain(res);
    const proj = lines.find((l) => l.type === "project");
    expect(proj).toMatchObject({ type: "project", yoloPages: 1 }); // yolo grouping ran

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    const pi = row.pageIntelligence as Record<string, any>;
    // exact key-set pin: with this fixture the yolo sub-branch writes EXACTLY these
    // four computed keys alongside the two carried user keys (observed 2026-07-08;
    // +pageZones [zones T2 2026-10-24] — written whenever the page has YOLO detections)
    expect(Object.keys(pi).sort()).toEqual([
      "classifiedRegions", "ensembleRegions", "pageZones", "parsedRegions", "someFutureKey", "yoloHeatmap",
    ]);
    // G3 carry still holds WITH the yolo path active
    expect(pi.parsedRegions).toEqual(userParsedRegions);
    expect(pi.someFutureKey).toEqual({ keep: "me" });
    // page zones: a text_box-only page has no title_block ⇒ the fixed-zone fallback, verbatim
    expect(pi.pageZones).toEqual({
      titleBlock: [0.45, 0.7, 1, 1], drawings: [], tables: [], legends: [], source: "fixed-fallback",
    });
    // heatmap: the seeded text_box detection became a confident region
    expect(pi.yoloHeatmap.confidentRegions.length).toBeGreaterThan(0);
    expect(pi.yoloHeatmap.confidentRegions[0].classes).toEqual(["text_box"]);
    // composite classifier: table region sourced FROM the user's parsedRegions
    expect(pi.classifiedRegions.tables[0]).toMatchObject({
      kind: "table", sources: ["parsedRegions"], pageNumber: 1,
    });
    // ensemble: a parsed-region vote survived into the reduced output — pins that
    // collectAllVotes still receives parsedRegions (the G3b source-of-truth read);
    // deleting the yolo/heatmap/ensemble sub-branch can no longer pass green (L3-1)
    expect(pi.ensembleRegions.length).toBeGreaterThan(0);
    expect(pi.ensembleRegions[0].reasoning).toContain("parsed-region");
    expect(pi.ensembleRegions[0].reasoning).toContain("yolo-heatmap");
  }, 30000);

  it("L3-2: intelligence WITHOUT debug=1 does NOT write the classifier debug bundle", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: richTextract, rawText: "" });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    await drain(res);
    expect(debugMocks.writeClassifierDebugBundle).not.toHaveBeenCalled();
  }, 30000);

  it("L3-4: default pipelineConfig does NOT invoke the auto-table detector (autoDetect off-by-default)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: richTextract, rawText: "" });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    await drain(res);
    expect(autoTableMocks.detectAutoTables).not.toHaveBeenCalled();
  }, 30000);

  // ── projectIds filter (case 7 — publicId contract) ───────────────────────────
  it("body {projectIds:[publicId]} scopes the run; unlisted projects untouched", async () => {
    // stale disciplines = the "A processed" witness (W8 refreshes it away);
    // pageCount purged jul9 P2-A S2
    const { company, user, project: projA } = await createWorld({
      projectIntelligence: { disciplines: ["stale-A"] } as any,
    });
    const admin = await createUser(company.id, { role: "admin" });
    const projB = await createProject(company.id, user.id, {
      projectIntelligence: { marker: "untouched" } as any,
    });
    await createPage(projA.id, 1, { textractData: emptyTextract, rawText: "" });
    await createPage(projB.id, 1, { textractData: emptyTextract, rawText: "" });

    asUser(admin);
    const res = await POST(
      makeReq("/api/admin/reprocess?scope=intelligence", {
        method: "POST",
        body: { projectIds: [projA.publicId] },
      }),
    );
    const lines = await drain(res);
    expect(lines[0]).toEqual({ type: "start", projects: 1 }); // filtered BEFORE the stream

    const [rowA] = await db.select().from(projects).where(eq(projects.id, projA.id));
    const [rowB] = await db.select().from(projects).where(eq(projects.id, projB.id));
    // A processed: W8 ran → seeded stale disciplines refreshed away (empty run →
    // key dropped) AND Wlib layered summaries
    expect(rowA.projectIntelligence).not.toHaveProperty("disciplines");
    expect((rowA.projectIntelligence as any)?.summaries).toBeDefined();
    expect(rowB.projectIntelligence).toEqual({ marker: "untouched" }); // B byte-identical
  }, 30000);

  // ── full/default scope (cases 8-9, 15) ───────────────────────────────────────
  it("default scope (no ?scope): W10 overwrites csiCodes/textAnnotations (null when none detected)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, {
      textractData: emptyTextract,
      rawText: "",
      csiCodes: [{ code: "99 99 99", description: "stale", trade: "t", division: "99" }] as any,
      textAnnotations: { annotations: [{ type: "note", text: "stale-ann" }] } as any,
    });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess", { method: "POST" }));
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await drain(res);
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 0, total: 1 });
    for (const l of lines.filter((l) => l.type === "progress")) {
      expect(l).not.toHaveProperty("skipped"); // full progress omits skipped (case 15)
    }
    expect(lines.some((l) => l.type === "project-summaries")).toBe(true);

    // nothing detectable in empty textract → route writes NULL over the stale values
    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.csiCodes).toBeNull();
    expect(row.textAnnotations).toBeNull();
  }, 30000);

  it("scope=full (unknown literal) falls through to default — NO validation, NO 400 (case 9)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: emptyTextract, rawText: "" });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=full", { method: "POST" }));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    // default-branch fingerprint: project-summaries emitted, done totals count the page
    expect(lines.some((l) => l.type === "project-summaries")).toBe(true);
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 0, total: 1 });
  }, 30000);

  // ── page-names scope (case 10) ───────────────────────────────────────────────
  it("scope=page-names: W1 fires only on change; config/project line shapes pinned", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    // page 1: stale AUTO name+drawingNumber → extractDrawingNumber(empty)=null → rename to "Page 1"
    // (owner 2026-10-21: reprocess must persist — was name "OLD-NAME", which is a user-typed
    // name and is now kept; see the manual-name case below.)
    const p1 = await createPage(project.id, 1, {
      name: "X-9",
      drawingNumber: "X-9",
      textractData: emptyTextract,
    });
    // page 2: already at the computed values → NO write, skipped++
    const p2 = await createPage(project.id, 2, { textractData: emptyTextract });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=page-names", { method: "POST" }));
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await drain(res);

    // config line: no pageNaming config → yoloEnabled is undefined and JSON-DROPPED,
    // fallback targetClasses=["title_block"], sources:0 — exact shape pin
    const cfg = lines.find((l) => l.type === "config");
    expect(cfg).toEqual({ type: "config", targetClasses: ["title_block"], sources: 0 });
    expect("yoloEnabled" in cfg!).toBe(false);
    const proj = lines.find((l) => l.type === "project");
    expect(proj).toEqual({ type: "project", name: project.name, pages: 2, yoloTitleBlocks: 0 });
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 1, total: 2 });

    const [row1] = await db.select().from(pages).where(eq(pages.id, p1.id));
    expect(row1.name).toBe("Page 1");
    expect(row1.drawingNumber).toBeNull();
    const [row2] = await db.select().from(pages).where(eq(pages.id, p2.id));
    expect(row2.name).toBe("Page 2"); // untouched
  }, 30000);

  // ── thumbnails scope (case 11 + §B owner pin) ────────────────────────────────
  it("scope=thumbnails: 72dpi thumb + 300dpi page uploads with the IMMUTABLE cache-control (viewer-perf SACRED)", async () => {
    const { company, project } = await createWorld({ numPages: 3 });
    const admin = await createUser(company.id, { role: "admin" });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=thumbnails", { method: "POST" }));
    const lines = await drain(res);

    // 3 pages × (thumbnail + full page) = 6 uploads, every one immutable-cached
    expect(s3Mocks.uploadToS3).toHaveBeenCalledTimes(6);
    expect(s3Mocks.uploadToS3).toHaveBeenCalledWith(
      `${project.dataUrl}/thumbnails/page_0001.png`,
      expect.anything(),
      "image/png",
      "public, max-age=31536000, immutable",
    );
    expect(s3Mocks.uploadToS3).toHaveBeenCalledWith(
      `${project.dataUrl}/pages/page_0001.png`,
      expect.anything(),
      "image/png",
      "public, max-age=31536000, immutable",
    );
    for (const call of s3Mocks.uploadToS3.mock.calls as unknown as unknown[][]) {
      expect(call[3]).toBe("public, max-age=31536000, immutable");
    }
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 3, skipped: 0, total: 3 });
    // thumbnails progress INCLUDES skipped (counter-shape pin, case 15)
    const prog = lines.filter((l) => l.type === "progress");
    expect(prog.length).toBeGreaterThan(0);
    for (const l of prog) {
      expect(Object.keys(l).sort()).toEqual(["project", "skipped", "total", "type", "updated"]);
    }
  }, 30000);

  it("scope=thumbnails: a durable project lease blocks publication across slow S3 work", async () => {
    const { company, project } = await createWorld({ numPages: 1 });
    await ageProjectForPublication(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    let signalUploadStarted!: () => void;
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
    const uploadReleased = new Promise<void>((resolve) => { releaseUpload = resolve; });
    s3Mocks.uploadToS3.mockImplementationOnce(async () => {
      signalUploadStarted();
      await uploadReleased;
    });

    asUser(admin);
    const reprocessResponse = await POST(
      makeReq("/api/admin/reprocess?scope=thumbnails", { method: "POST" }),
    );
    await uploadStarted;

    const publish = await readJson(await demoPOST(makeReq("/api/admin/demo", {
      method: "POST",
      body: { projectId: project.publicId, isDemo: true },
    })));
    expect(publish.status).toBe(409);
    expect(publish.body).toEqual({
      error: { code: "CONFLICT", message: "Project has an active mutation lease" },
    });

    releaseUpload();
    const lines = await drain(reprocessResponse);
    expect(lines[lines.length - 1]).toEqual({
      type: "done",
      updated: 1,
      skipped: 0,
      total: 1,
    });
  }, 30000);

  it("scope=thumbnails: missing PDF → in-stream {type:'error', error:'PDF not found in S3'} verbatim, run continues", async () => {
    const { company, project } = await createWorld({ numPages: 1 });
    const admin = await createUser(company.id, { role: "admin" });
    s3Mocks.downloadFromS3.mockRejectedValueOnce(new Error("nope"));

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=thumbnails", { method: "POST" }));
    const lines = await drain(res);
    expect(lines).toContainEqual({
      type: "error",
      project: project.name,
      error: "PDF not found in S3",
    });
    expect(lines[lines.length - 1].type).toBe("done"); // continue, not abort
  }, 30000);

  it("scope=thumbnails: project-level failure streams RAW err.message at 200 (§B owner-locked: domain data, preserve verbatim)", async () => {
    const { company, project } = await createWorld({ numPages: null as any });
    const admin = await createUser(company.id, { role: "admin" });
    // numPages null → route calls getPdfPageCount → throw reaches the OUTER project catch
    rasterMocks.getPdfPageCount.mockRejectedValueOnce(new Error("kaboom-outer"));

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=thumbnails", { method: "POST" }));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    expect(lines).toContainEqual({
      type: "error",
      project: project.name,
      error: "kaboom-outer", // raw err.message INSIDE the 200 stream — NOT a B-retire site
    });
  }, 30000);

  // ── shape-parse scope (cases 12-13) ──────────────────────────────────────────
  it("scope=shape-parse sequential: W2 deletes ONLY shape-parse annotations, W5/W6 write keynotes (case 12)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, {});
    // pre-existing annotations: shape-parse must be wiped by W2, yolo must SURVIVE
    await db.insert(annotations).values([
      { name: "stale-shape", minX: 0, minY: 0, maxX: 1, maxY: 1, pageNumber: 1, threshold: 0.9, source: "shape-parse", projectId: project.id, data: {} as any },
      { name: "title_block", minX: 0, minY: 0, maxX: 1, maxY: 1, pageNumber: 1, threshold: 0.9, source: "yolo", projectId: project.id, data: {} as any },
    ]);
    keynotesMocks.extractKeynotes.mockResolvedValueOnce({
      keynotes: [{ shape: "hexagon", bbox: [1, 2, 3, 4], text: "K1", contour: [[0, 0]] }],
      warnings: [],
    });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=shape-parse", { method: "POST" }));
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await drain(res);
    expect(lines.find((l) => l.type === "config")).toEqual({ type: "config", useLambda: false });
    // owner 2026-10-21: reprocess must persist — done now splits skipped into empty/failed.
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 0, empty: 0, failed: 0, total: 1 });

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.keynotes).toEqual([{ shape: "hexagon", bbox: [1, 2, 3, 4], text: "K1", contour: [[0, 0]] }]);
    const anns = await annotationsFor(project.id);
    expect(anns.some((a) => a.name === "stale-shape")).toBe(false); // W2 wiped
    expect(anns.some((a) => a.source === "yolo" && a.name === "title_block")).toBe(true); // yolo survives
    const created = anns.find((a) => a.source === "shape-parse");
    expect(created).toMatchObject({
      name: "hexagon", minX: 1, minY: 2, maxX: 3, maxY: 4, pageNumber: 1, threshold: 0.9,
    });
    expect((created!.data as any).modelName).toBe("shape-parse");
  }, 30000);

  it("scope=shape-parse lambda: config useLambda:true, W3/W4 writes, progress INCLUDES skipped (case 13)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, {});
    lambdaMocks.isLambdaCvEnabled.mockReturnValueOnce(true);
    const key = `${project.dataUrl}/pages/page_0001.png`;
    lambdaMocks.fanOutShapeParse.mockResolvedValueOnce({
      results: [{ pageS3Key: key, shape: "cloud", bbox: [5, 6, 7, 8], text: "L1", contour: [[1, 1]] }],
      okPages: [key], failedPages: [], pageErrors: {}, warnings: [],
    });

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=shape-parse", { method: "POST" }));
    const lines = await drain(res);
    expect(lines.find((l) => l.type === "config")).toEqual({ type: "config", useLambda: true });
    // unconditional post-lambda progress line carries `skipped` (case 15 pin)
    // owner 2026-10-21: reprocess must persist — progress/done also carry empty + failed.
    const prog = lines.filter((l) => l.type === "progress");
    expect(prog.length).toBeGreaterThan(0);
    expect(Object.keys(prog[0]).sort()).toEqual(["empty", "failed", "project", "skipped", "total", "type", "updated"]);
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 1, skipped: 0, empty: 0, failed: 0, total: 1 });
    expect(keynotesMocks.extractKeynotes).not.toHaveBeenCalled(); // Lambda scanned it — no local run

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    // stored without the fan-out's transport field
    expect(row.keynotes).toEqual([{ shape: "cloud", text: "L1", bbox: [5, 6, 7, 8], contour: [[1, 1]] }]);
    const anns = await annotationsFor(project.id);
    expect(anns.find((a) => a.source === "shape-parse")).toMatchObject({ name: "cloud", minX: 5, minY: 6, maxX: 7, maxY: 8 });
  }, 30000);

  it("scope=shape-parse lambda THROW: verbatim warning line, sequential fallback runs (case 13b)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, {});
    lambdaMocks.isLambdaCvEnabled.mockReturnValueOnce(true);
    lambdaMocks.fanOutShapeParse.mockRejectedValueOnce(new Error("lambda-down"));
    // fallback: default extractKeynotes → {keynotes:[]} → skipped++

    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=shape-parse", { method: "POST" }));
    const lines = await drain(res);
    // owner 2026-10-21: reprocess must persist — the warning names the reason now.
    expect(lines).toContainEqual({
      type: "warning",
      project: project.name,
      message: "Lambda fan-out failed (lambda-down) — scanning every page locally",
    });
    expect(keynotesMocks.extractKeynotes).toHaveBeenCalled(); // fallback actually ran
    // the local scan succeeded and found nothing → a confirmed EMPTY page, not a failure
    expect(lines[lines.length - 1]).toEqual({ type: "done", updated: 0, skipped: 1, empty: 1, failed: 0, total: 1 });
  }, 30000);

  // ── shape-parse observe warn-net (rides commit U7-B) [refactor jul23 P4.1 U7] ──
  // Log-mode contract (spec Verdict 2 / RD-U7d): a valid pipeline blob → zero
  // [shape-registry] warns; a malformed blob STILL persists (log+skip, gate:false — a throw
  // would poison the NDJSON stream) + exactly ONE aggregated warn carrying the sink+kind.
  // shapeType comes from k.shape; a number violates zShapeParseData.shapeType (string) while
  // the varchar `name` col coerces to "9" so the row still inserts. Scoped logger spy
  // restored per-test — a blanket restoreAllMocks would nuke the vi.hoisted mock defaults.
  describe("shape-parse observe warn-net [U7]", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(logger, "warn");
    });
    afterEach(() => warnSpy.mockRestore());

    const runShapeParse = async () => {
      const res = await POST(
        makeReq("/api/admin/reprocess?scope=shape-parse", { method: "POST" }),
      );
      return drain(res);
    };

    it("sequential VALID keynote → shape-parse row persists with ZERO shape-registry warns", async () => {
      const { company, project } = await createWorld();
      const admin = await createUser(company.id, { role: "admin" });
      await createPage(project.id, 1, {});
      keynotesMocks.extractKeynotes.mockResolvedValueOnce({
        keynotes: [{ shape: "hexagon", bbox: [1, 2, 3, 4], text: "K1", contour: [[0, 0]] }],
        warnings: [],
      });

      asUser(admin);
      await runShapeParse();

      const anns = await annotationsFor(project.id);
      expect(anns.some((a) => a.source === "shape-parse")).toBe(true);
      expect(shapeRegistryWarns(warnSpy)).toHaveLength(0);
    }, 30000);

    it("sequential MALFORMED (shapeType number) → row STILL persists (log-only) + ONE warn {sink:reprocess.shapeParse.sequential, kind:shape-parse}", async () => {
      const { company, project } = await createWorld();
      const admin = await createUser(company.id, { role: "admin" });
      await createPage(project.id, 1, {});
      keynotesMocks.extractKeynotes.mockResolvedValueOnce({
        keynotes: [{ shape: 9, bbox: [1, 2, 3, 4], text: "K1", contour: [[0, 0]] }],
        warnings: [],
      });

      asUser(admin);
      await runShapeParse();

      const created = (await annotationsFor(project.id)).find((a) => a.source === "shape-parse");
      expect(created).toBeDefined(); // ← log-only: v0 write never blocked
      expect((created!.data as Record<string, unknown>).shapeType).toBe(9);
      const calls = shapeRegistryWarns(warnSpy);
      expect(calls).toHaveLength(1);
      const ctx = calls[0][1] as Record<string, unknown>;
      expect(ctx.sink).toBe("reprocess.shapeParse.sequential");
      expect(ctx.kind).toBe("shape-parse");
    }, 30000);

    it("fan-out MALFORMED (shapeType number via fanOutShapeParse) → row STILL persists + ONE warn {sink:reprocess.shapeParse.fanout, kind:shape-parse}", async () => {
      const { company, project } = await createWorld();
      const admin = await createUser(company.id, { role: "admin" });
      await createPage(project.id, 1, {});
      lambdaMocks.isLambdaCvEnabled.mockReturnValueOnce(true);
      lambdaMocks.fanOutShapeParse.mockResolvedValueOnce({
        results: [
          {
            pageS3Key: `${project.dataUrl}/pages/page_0001.png`,
            shape: 9,
            bbox: [5, 6, 7, 8],
            text: "L1",
            contour: [[1, 1]],
          },
        ],
      });

      asUser(admin);
      await runShapeParse();

      const created = (await annotationsFor(project.id)).find((a) => a.source === "shape-parse");
      expect(created).toBeDefined();
      expect((created!.data as Record<string, unknown>).shapeType).toBe(9);
      const calls = shapeRegistryWarns(warnSpy);
      expect(calls).toHaveLength(1);
      const ctx = calls[0][1] as Record<string, unknown>;
      expect(ctx.sink).toBe("reprocess.shapeParse.fanout");
      expect(ctx.kind).toBe("shape-parse");
    }, 30000);
  });

  // ── T2 demo-write exclusion (P1-review, owner-sanctioned 2026-07-08) ─────────
  it("T2: isDemo projects are EXCLUDED from reprocess — not counted, never written", async () => {
    // stale disciplines = the "normal processed" witness (W8 refreshes it away);
    // pageCount purged jul9 P2-A S2
    const { company, user, project: normal } = await createWorld({
      projectIntelligence: { disciplines: ["stale-normal"] } as any,
    });
    const admin = await createUser(company.id, { role: "admin" });
    const demoProj = await createProject(company.id, user.id, {
      isDemo: false,
      projectIntelligence: { curated: "demo-content" } as any,
    });
    await createPage(normal.id, 1, { textractData: emptyTextract, rawText: "" });
    await createPage(demoProj.id, 1, { textractData: emptyTextract, rawText: "" });
    await ageProjectForPublication(demoProj.id);

    asUser(admin);
    expect((await readJson(await demoPOST(makeReq("/api/admin/demo", {
      method: "POST",
      body: { projectId: demoProj.publicId, isDemo: true },
    })))).status).toBe(200);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    const lines = await drain(res);
    expect(lines[0]).toEqual({ type: "start", projects: 1 }); // demo project NOT counted

    const [demoRow] = await db.select().from(projects).where(eq(projects.id, demoProj.id));
    expect(demoRow.projectIntelligence).toEqual({ curated: "demo-content" }); // byte-untouched
    const [normalRow] = await db.select().from(projects).where(eq(projects.id, normal.id));
    // normal still processed: stale disciplines refreshed away + Wlib summaries present
    expect(normalRow.projectIntelligence).not.toHaveProperty("disciplines");
    expect((normalRow.projectIntelligence as any)?.summaries).toBeDefined();
  }, 30000);

  // ── §E-a body policy (case 17 — owner-locked 2026-07-08: PRESERVE the swallow) ─
  it("§E-a: admin + MALFORMED JSON body → 200, swallowed, processes ALL company projects", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: emptyTextract, rawText: "" });

    asUser(admin);
    const res = await POST(rawBodyReq("/api/admin/reprocess?scope=intelligence", "{not-json"));
    expect(res.status).toBe(200); // NO 400 — the swallow is load-bearing
    const lines = await drain(res);
    expect(lines[0]).toEqual({ type: "start", projects: 1 });
  }, 30000);

  it("§E-a: admin + NON-OBJECT body (42) → 200, swallowed, processes all (US-20-class)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await createPage(project.id, 1, { textractData: emptyTextract, rawText: "" });

    asUser(admin);
    const res = await POST(rawBodyReq("/api/admin/reprocess?scope=intelligence", "42"));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    expect(lines[0]).toEqual({ type: "start", projects: 1 });
  }, 30000);

  it("§E-a ORDERING pin: signed-out + malformed body → 401 (auth BEFORE parse; rawBody:true must NOT flip this to 400)", async () => {
    signedOut();
    const res = await POST(rawBodyReq("/api/admin/reprocess", "{not-json"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
  });
});
