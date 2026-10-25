// @vitest-environment node
// [refactor jul5 S027] CHARACTERIZATION for POST /api/table-parse, written as THE FREEZE
// before the P1.5 fold onto services/table-parse.ts (route contract; the merge-pipeline
// ENGINE @/lib/services/table-parse is a DIFFERENT module and stays byte-untouched). The
// heaviest mock surface of the parse family (8 seams): lib/services/table-parse methods,
// grid-merger.mergeGrids, csi-detect.detectCsiFromGrid, img2table-extract, textract
// .analyzePageImage, s3.downloadFromS3, pdf-rasterize.rasterizePage, "sharp" (dynamic
// import inside the route-local crop helper), parse-history.addToHistory (spy). Frozen:
//   • TQ-1 pre-try cascade (validate-before-auth): req.json() + field-400 + bbox-400 +
//     resolveProjectAccess({dbId},{allowDemo:true}) + project.isDemo→assertDemoFeatureEnabled
//     (companyId,"tableParse") flat 403 all sit OUTSIDE the try → malformed/empty/null
//     bodies and non-castable dbId strings REJECT RAW at legacy (framework 500), they do
//     NOT hit the catch-all. Demo gate keys off project.isDemo (symbol-search convention,
//     NOT ai-chat's scope) and stays FLAT at fold (demo-features owns the shape).
//   • TQ-2 the try wraps the pipeline: page-404 "Page has no OCR data" (INSIDE try, unlike
//     the 5 S026 clones' shared helper ordering — same observable order though), appSettings
//     override read (own swallow catch), infra fetch/rasterize, method fan-out, merge, CSI,
//     history. Catch-all LEAKS err.message ?? "Table parsing failed" at flat 500 → diff B.
//   • TQ-3 effectiveDebugMode = request debugMode || appSettings["tableParse.debugMode"]
//     .value.enabled (persistent admin override; row seeded in the test DB).
//   • TQ-4 response: default = {...merged, csiTags?, infraErrors}; debug adds methodResults
//     (filtered: headers>0&&rows>0 || error), infraStages, totalDurationMs (typeof number
//     ONLY — nondeterministic). csiTags attached via best-effort empty-catch: on
//     detectCsiFromGrid throw the KEY IS ABSENT. randomUUID/ISO history values go to the
//     in-memory ring buffer only (addToHistory spy), never the response.
//   • TQ-5 textract method resolution: cache-hit when textractData.tables has ≥30% overlap
//     with the region → methodTextractTables(CACHED tables, bbox), no S3/live call; else
//     live path = downloadFromS3(dataUrl/pages/page_NNNN.png PADDED) → sharp crop → analyze
//     PageImage(cropped) → remap bboxes back to full-page coords → methodTextractTables
//     (remapped, bbox); any live-path throw soft-fails to methodTextractTables(undefined,
//     bbox). Region-specific results are deliberately NOT cached back.
//   • TQ-6 infra failures are explicit: pdf-download/rasterize errors land in infraErrors
//     (always in the response) and gate method skips — no pdf+png → opencv skipped
//     "skipped: page image unavailable (see infraErrors)" + img2table skipped "skipped: PDF
//     and page image unavailable (see infraErrors)"; rasterize-only failure → opencv
//     skipped but img2table RUNS (pdfBuffer || pngBuffer).
//   • TQ-7 engine args: methodOcrPositions(textractData.words, bbox MINMAX, {rowTolerance,
//     minColGap, colHitRatio, headerMode}); methodOpenCvLines(pdfBuffer, pageNumber, bbox,
//     words, {minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance});
//     extractWithImg2Table(pdfBuffer, pngBuffer, pageNumber, bbox); mergeGrids(flatResults,
//     {editDistanceThreshold: mergerEditDistance}).
// Assertions tagged [S027 fold] flip in the fold commit (sanctioned diffs A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  methodShapeRows: vi.fn(),
  methodOcrPositions: vi.fn(),
  methodTextractTables: vi.fn(),
  methodOpenCvLines: vi.fn(),
  mergeGrids: vi.fn(),
  detectCsiFromGrid: vi.fn(),
  extractWithImg2Table: vi.fn(),
  analyzePageImage: vi.fn(),
  downloadFromS3: vi.fn(),
  rasterizePage: vi.fn(),
  addToHistory: vi.fn(),
  sharp: vi.fn(),
}));

vi.mock("@/lib/services/table-parse", () => ({
  methodOcrPositions: h.methodOcrPositions,
  methodTextractTables: h.methodTextractTables,
  methodOpenCvLines: h.methodOpenCvLines,
}));
vi.mock("@/lib/grid-merger", () => ({ mergeGrids: h.mergeGrids }));
// [shape-tags fix round] the shape-centre row builder (5th method behind rowSource "shape-centres")
vi.mock("@/lib/services/table-rows-shapes", () => ({ methodShapeRows: h.methodShapeRows, SHAPE_ROWS_METHOD: "shape-rows" }));
vi.mock("@/lib/csi-detect", () => ({ detectCsiFromGrid: h.detectCsiFromGrid, detectCsiCodes: vi.fn() }));
vi.mock("@/lib/img2table-extract", () => ({ extractWithImg2Table: h.extractWithImg2Table }));
// Full mock keeps the AWS SDK out of the graph (symbol-search precedent).
vi.mock("@/lib/textract", () => ({ analyzePageImage: h.analyzePageImage }));
vi.mock("@/lib/s3", () => ({
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  downloadFromS3: h.downloadFromS3,
  uploadToS3: vi.fn(),
  deleteProjectFiles: vi.fn(),
}));
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: h.rasterizePage }));
vi.mock("@/lib/parse-history", () => ({ addToHistory: h.addToHistory }));
// The route's crop helper does `(await import("sharp")).default` — vi.mock intercepts
// dynamic imports too (S024 child_process precedent).
vi.mock("sharp", () => ({ default: h.sharp }));

import { POST } from "@/app/api/table-parse/route";
import {
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";
import { db } from "@/lib/db";
import { annotations, appSettings, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;

const BBOX: [number, number, number, number] = [0.1, 0.1, 0.5, 0.5];
const WORDS = [{ text: "w1" }];
const TEXTRACT_NO_TABLES = { words: WORDS, lines: [] };
// bbox LTWH [0.1,0.1,0.3,0.3] ∩ region [0.1,0.1→0.5,0.5] = 0.09 / regionArea 0.16 = 56% ≥ 30%
const CACHED_TABLE = { bbox: [0.1, 0.1, 0.3, 0.3], cells: [] };
const TEXTRACT_WITH_TABLES = { words: WORDS, lines: [], tables: [CACHED_TABLE] };

const mr = (method: string, over: Record<string, unknown> = {}) => ({
  method,
  headers: ["Tag"],
  rows: [{ Tag: "A1" }],
  confidence: 0.5,
  ...over,
});
const MERGED = {
  headers: ["Tag", "Desc"],
  rows: [{ Tag: "A1", Desc: "door" }],
  confidence: 0.82,
  tagColumn: "Tag",
  methods: ["ocr-positions"],
  mergerNotes: [] as string[],
};

const call = (b: unknown) => POST(makeReq("/api/table-parse", { body: b }));
const bodyFor = (projectId: unknown, over: Record<string, unknown> = {}) => ({
  projectId,
  pageNumber: 1,
  regionBbox: BBOX,
  ...over,
});

function pngDims(w = 1000, hgt = 800): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(hgt, 20);
  return buf;
}

async function world(textractData: unknown = TEXTRACT_WITH_TABLES, projectOver = {}) {
  const w = await createWorld(projectOver);
  await createPage(w.project.id, 1, { textractData: textractData as never });
  return w;
}

beforeEach(async () => {
  vi.clearAllMocks();
  signedOut();
  // crash-residue guard (standalone-lens F2): the debug-override key is GLOBAL in the shared
  // parallel DB — a crashed prior run could leave it enabled and flake default-response asserts
  await db.delete(appSettings).where(eq(appSettings.key, "tableParse.debugMode"));
  h.methodOcrPositions.mockReturnValue(mr("ocr-positions"));
  h.methodTextractTables.mockReturnValue(mr("textract-tables"));
  h.methodOpenCvLines.mockResolvedValue(mr("opencv-lines"));
  h.extractWithImg2Table.mockResolvedValue(mr("img2table"));
  h.mergeGrids.mockReturnValue({ ...MERGED });
  h.detectCsiFromGrid.mockReturnValue([{ code: "08 00 00", description: "Openings", trade: "doors" }]);
  h.analyzePageImage.mockResolvedValue({ tables: [] });
  // one impl serves both S3 reads: original.pdf and the page PNG
  h.downloadFromS3.mockImplementation(async (key: string) =>
    key.endsWith(".pdf") ? Buffer.from("pdf") : pngDims(),
  );
  h.rasterizePage.mockResolvedValue(pngDims());
  h.sharp.mockImplementation(() => ({
    metadata: async () => ({ width: 1000, height: 800 }),
    extract: () => ({ png: () => ({ toBuffer: async () => Buffer.from("cropped") }) }),
  }));
});

describe.skipIf(!dbUp)("POST /api/table-parse — pre-try cascade (TQ-1)", () => {
  it("truthy missing-field / bad-bbox 400s (falsy-zero quirk; long bbox message)", async () => {
    for (const b of [bodyFor(0), { projectId: 1, regionBbox: BBOX }, bodyFor(1, { regionBbox: [0.1] })]) {
      const { status, body } = await readJson(await call(b));
      expect(status).toBe(400);
      // [S027 fold: A applied — was flat]
      expect(body).toEqual({
        error: { code: "VALIDATION", message: "Missing projectId, pageNumber, or regionBbox" },
      });
    }
    const { status, body } = await readJson(await call(bodyFor(1, { regionBbox: [0.5, 0.1, 0.1, 0.5] })));
    expect(status).toBe(400);
    // [S027 fold: A applied]
    expect(body).toEqual({
      error: {
        code: "VALIDATION",
        message: "Invalid regionBbox: values must be finite numbers in [0,1] with min < max",
      },
    });
  });

  it("malformed / empty / 'null' bodies → clean 400s from the shell body-parse", async () => {
    // [S027 fold: E applied — legacy req.json() was OUTSIDE any try → raw rejections]
    const mk = (raw: string | undefined) =>
      new Request("http://test.local/api/table-parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    let r = await readJson(await POST(mk("{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    for (const raw of [undefined, "null"]) {
      r = await readJson(await POST(mk(raw)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
  });

  it("number/array body → 400 VALIDATION via zLooseBody", async () => {
    // [S027 fold: E applied — legacy destructured to undefined → flat "Missing…" 400;
    // status preserved, message drifts to zod wording → code-only assert]
    for (const raw of ["5", "[1]"]) {
      const req = new Request("http://test.local/api/table-parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const { status, body } = await readJson(await POST(req));
      expect(status).toBe(400);
      expect(body.error.code).toBe("VALIDATION");
    }
  });

  it("access matrix: signed-out 401 / cross-tenant 404 / negative 404 / non-castable REJECTS", async () => {
    const { project } = await world();
    let r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S027 fold: A applied]
    const other = await createCompany();
    asUser(await createUser(other.id));
    r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S027 fold: A applied]
    r = await readJson(await call(bodyFor(-5)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // int-guard DECLINED — pinned [S027 fold: A applied]
    // [S027 fold: B applied — legacy pg-cast rejected raw; now the shell's generic 500]
    r = await readJson(await call(bodyFor("not-a-number")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  it("demo gate: project.isDemo + tableParse disabled → FLAT 403 (does NOT flip at fold); default-on → runs", async () => {
    const { company, project } = await world(TEXTRACT_WITH_TABLES);
    await publishDemoFixture(project.id);
    await db.update(companies).set({ pipelineConfig: { demo: { tableParse: false } } }).where(eq(companies.id, company.id));
    let r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(403);
    // demo-features.ts owns this flat shape — flips only when THAT module migrates
    expect(r.body).toEqual({ error: "Table/Schedule Parse is disabled for demo users. Sign in to use this feature." });
    await db.update(companies).set({ pipelineConfig: {} }).where(eq(companies.id, company.id));
    r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(200); // DEFAULT_ON.tableParse = true; anon demo read allowed (allowDemo:true)
  });

  it("page without textractData → 404 'Page has no OCR data'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {});
    asUser(user);
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: "NOT_FOUND", message: "Page has no OCR data" } }); // [S027 fold: A applied]
  });
});

describe.skipIf(!dbUp)("POST /api/table-parse — pipeline happy path (TQ-4/5/7)", () => {
  it("cache-hit textract + all methods run; default response = {...merged, csiTags, infraErrors:[]}", async () => {
    const { user, project } = await world();
    asUser(user);
    const opts = { rowTolerance: 0.02, minColGap: 3, colHitRatio: 0.6, headerMode: "first", mergerEditDistance: 2 };
    const { status, body } = await readJson(await call(bodyFor(project.id, opts)));
    expect(status).toBe(200);
    // TQ-7 arg contracts
    expect(h.methodOcrPositions).toHaveBeenCalledWith(WORDS, BBOX, {
      rowTolerance: 0.02, minColGap: 3, colHitRatio: 0.6, headerMode: "first",
    });
    // TQ-5 cache-hit: the SEEDED tables array, no S3 page-png fetch, no live textract
    expect(h.methodTextractTables).toHaveBeenCalledWith([CACHED_TABLE], BBOX);
    expect(h.analyzePageImage).not.toHaveBeenCalled();
    expect(h.methodOpenCvLines).toHaveBeenCalledWith(
      expect.any(Buffer), 1, BBOX, WORDS,
      { minHLineLengthRatio: undefined, minVLineLengthRatio: undefined, clusteringTolerance: undefined },
    );
    expect(h.extractWithImg2Table).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Buffer), 1, BBOX);
    // timed() injects debug.durationMs into EVERY result before the merger sees it (frozen)
    const timedMr = (m: string) => ({ ...mr(m), debug: { durationMs: expect.any(Number) } });
    expect(h.mergeGrids).toHaveBeenCalledWith(
      [timedMr("ocr-positions"), timedMr("textract-tables"), timedMr("opencv-lines"), timedMr("img2table")],
      { editDistanceThreshold: 2 },
    );
    // TQ-4 default response: merged + csiTags (2-key mapped) + infraErrors; NO debug fields
    expect(body).toEqual({
      ...MERGED,
      csiTags: [{ code: "08 00 00", description: "Openings" }],
      infraErrors: [],
    });
    // history ring buffer written with FULL methodResults regardless of debugMode
    expect(h.addToHistory).toHaveBeenCalledTimes(1);
    const entry = h.addToHistory.mock.calls[0][0];
    expect(entry.response.methodResults).toHaveLength(4);
    expect(typeof entry.id).toBe("string"); // randomUUID — shape only
    expect(typeof entry.response.durationMs).toBe("number");
  });

  it("[shape-tags fix round] rowSource 'shape-centres' adds the shape-rows method from the page's yolo_primitive rows + classical keynotes; off by default", async () => {
    const { user, project } = await createWorld();
    const keynote = { shape: "circle", text: "7", bbox: [0.12, 0.3, 0.14, 0.32] };
    await createPage(project.id, 1, { textractData: TEXTRACT_WITH_TABLES as never, keynotes: [keynote] as never });
    const row = (name: string, modelName: string, y: number) => ({
      projectId: project.id, pageNumber: 1, name, source: "yolo", minX: 0.11, minY: y, maxX: 0.13, maxY: y + 0.02, data: { modelName, confidence: 0.9 } as never,
    });
    await db.insert(annotations).values([row("hexagon", "yolo_primitive", 0.2), row("tables", "yolo_medium", 0.1), { ...row("hexagon", "yolo_primitive", 0.25), source: "user" }]);
    asUser(user);
    h.methodShapeRows.mockReturnValue(mr("shape-rows", { tagColumn: "Tag" }));
    // default: not run, four results merge
    let r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(200);
    expect(h.methodShapeRows).not.toHaveBeenCalled();
    expect(h.mergeGrids.mock.calls[0][0]).toHaveLength(4);
    // with the hint: the yolo_primitive annotation (not yolo_medium, not a user box) + the classical keynote, as a 5th timed result
    r = await readJson(await call(bodyFor(project.id, { rowSource: "shape-centres", minColGap: 0.02 })));
    expect(r.status).toBe(200);
    expect(h.methodShapeRows).toHaveBeenCalledWith(WORDS, [
      { label: "hexagon", bbox: [0.11, 0.2, 0.13, 0.22], source: "yolo", confidence: 0.9 },
      { label: "circle", bbox: keynote.bbox, source: "classical", confidence: 1, text: "7" },
    ], BBOX, { minColGap: 0.02, colHitRatio: undefined });
    const results = h.mergeGrids.mock.calls[1][0];
    expect(results).toHaveLength(5);
    expect(results[4]).toEqual({ ...mr("shape-rows", { tagColumn: "Tag" }), debug: { durationMs: expect.any(Number) } });
    expect(h.addToHistory.mock.calls[1][0].request.options.rowSource).toBe("shape-centres");
    expect("rowSource" in h.addToHistory.mock.calls[0][0].request.options).toBe(false);
    // a throw inside the row builder is that method's soft failure, not the request's
    h.methodShapeRows.mockImplementation(() => { throw new Error("rows exploded"); });
    r = await readJson(await call(bodyFor(project.id, { rowSource: "shape-centres" })));
    expect(r.status).toBe(200);
    expect(h.mergeGrids.mock.calls[2][0][4]).toMatchObject({ method: "shape-rows", confidence: 0, error: "rows exploded" });
  });

  it("csiTags: detectCsiFromGrid throw → key ABSENT (best-effort empty catch)", async () => {
    const { user, project } = await world();
    asUser(user);
    h.detectCsiFromGrid.mockImplementation(() => {
      throw new Error("csi died");
    });
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200);
    expect("csiTags" in body).toBe(false);
    expect(body.headers).toEqual(MERGED.headers);
  });

  it("TQ-5 live textract path: crop → analyze → REMAP to full-page coords; miss stays uncached", async () => {
    const { user, project } = await world(TEXTRACT_NO_TABLES);
    asUser(user);
    h.analyzePageImage.mockResolvedValue({
      tables: [{ bbox: [0.2, 0.2, 0.5, 0.5], cells: [{ bbox: [0.25, 0.25, 0.1, 0.1], text: "c" }] }],
    });
    await call(bodyFor(project.id));
    expect(h.sharp).toHaveBeenCalled(); // crop ran
    expect(h.analyzePageImage).toHaveBeenCalledWith(Buffer.from("cropped"));
    // page PNG fetched with the PADDED key
    const keys = h.downloadFromS3.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.endsWith("/pages/page_0001.png"))).toBe(true);
    // remap: region [0.1,0.1→0.5,0.5] (w=h=0.4): [0.2,0.2,0.5,0.5] → [0.18,0.18,0.2,0.2]
    const remapped = h.methodTextractTables.mock.calls[0][0];
    expect(remapped).toHaveLength(1);
    expect(remapped[0].bbox[0]).toBeCloseTo(0.18, 10);
    expect(remapped[0].bbox[1]).toBeCloseTo(0.18, 10);
    expect(remapped[0].bbox[2]).toBeCloseTo(0.2, 10);
    expect(remapped[0].bbox[3]).toBeCloseTo(0.2, 10);
    expect(remapped[0].cells[0].bbox[0]).toBeCloseTo(0.2, 10);
  });

  it("TQ-5 live-path throw soft-fails to methodTextractTables(undefined, bbox)", async () => {
    const { user, project } = await world(TEXTRACT_NO_TABLES);
    asUser(user);
    h.analyzePageImage.mockRejectedValue(new Error("textract down"));
    const { status } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200); // soft-fail, parse continues
    expect(h.methodTextractTables).toHaveBeenCalledWith(undefined, BBOX);
  });
});

describe.skipIf(!dbUp)("POST /api/table-parse — infra failures (TQ-6) + debug (TQ-3/4)", () => {
  it("pdf download fails → infraErrors in response; opencv AND img2table skipped with reasons", async () => {
    const { user, project } = await world();
    asUser(user);
    h.downloadFromS3.mockImplementation(async (key: string) => {
      if (key.endsWith(".pdf")) throw new Error("S3 down");
      return pngDims();
    });
    const { status, body } = await readJson(await call(bodyFor(project.id, { debugMode: true })));
    expect(status).toBe(200);
    expect(body.infraErrors).toEqual([{ stage: "pdf-download", error: "S3 down" }]);
    expect(h.methodOpenCvLines).not.toHaveBeenCalled();
    expect(h.extractWithImg2Table).not.toHaveBeenCalled();
    const skipped = body.methodResults.filter((r: { error?: string }) => r.error?.startsWith("skipped"));
    expect(skipped.map((r: { method: string; error: string }) => [r.method, r.error])).toEqual([
      ["opencv-lines", "skipped: page image unavailable (see infraErrors)"],
      ["img2table", "skipped: PDF and page image unavailable (see infraErrors)"],
    ]);
  });

  it("rasterize fails (pdf ok) → opencv skipped but img2table RUNS (pdf||png)", async () => {
    const { user, project } = await world();
    asUser(user);
    h.rasterizePage.mockRejectedValue(new Error("raster boom"));
    const { body } = await readJson(await call(bodyFor(project.id)));
    expect(body.infraErrors).toEqual([{ stage: "rasterize", error: "raster boom" }]);
    expect(h.methodOpenCvLines).not.toHaveBeenCalled();
    expect(h.extractWithImg2Table).toHaveBeenCalledWith(expect.any(Buffer), null, 1, BBOX);
  });

  it("debugMode:true → methodResults(filtered)/infraStages/totalDurationMs; default omits them", async () => {
    const { user, project } = await world();
    asUser(user);
    // one empty non-error result must be FILTERED OUT of the debug methodResults
    h.methodOcrPositions.mockReturnValue(mr("ocr-positions", { headers: [], rows: [] }));
    const { body } = await readJson(await call(bodyFor(project.id, { debugMode: true })));
    expect(body.methodResults.map((r: { method: string }) => r.method)).toEqual([
      "textract-tables", "opencv-lines", "img2table",
    ]);
    expect(Array.isArray(body.infraStages)).toBe(true);
    expect(body.infraStages.map((s: { stage: string }) => s.stage)).toEqual(["pdf-download", "rasterize"]);
    expect(typeof body.totalDurationMs).toBe("number"); // nondeterministic — shape only
    // [S027 DETECTOR TP-1 closer] the history ring buffer must get the FULL UNFILTERED set
    // even while the response filters — this is the ONLY case where they diverge (3 vs 4)
    const entry = h.addToHistory.mock.calls[0][0];
    expect(entry.response.methodResults).toHaveLength(4);
    expect(entry.response.methodResults.map((r: { method: string }) => r.method)).toContain("ocr-positions");
    // default response omits all three
    const { body: plain } = await readJson(await call(bodyFor(project.id)));
    for (const k of ["methodResults", "infraStages", "totalDurationMs"]) expect(k in plain).toBe(false);
  });

  it("TQ-3 appSettings persistent override forces debug fields even with debugMode:false", async () => {
    const { user, project } = await world();
    asUser(user);
    await db.insert(appSettings).values({ key: "tableParse.debugMode", value: { enabled: true } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { enabled: true } } });
    try {
      const { body } = await readJson(await call(bodyFor(project.id)));
      expect("methodResults" in body).toBe(true);
      expect(typeof body.totalDurationMs).toBe("number");
    } finally {
      await db.delete(appSettings).where(eq(appSettings.key, "tableParse.debugMode")); // shared DB hygiene
    }
  });

  it("pipeline throw (mergeGrids) → generic INTERNAL 500, leak dropped", async () => {
    // [S027 fold: B applied — legacy catch-all leaked {error:"merge exploded"} flat 500]
    const { user, project } = await world();
    asUser(user);
    h.mergeGrids.mockImplementation(() => {
      throw new Error("merge exploded");
    });
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
});

// [hardening sep30] Demo projects are anonymous and the caller picks the region, so the caller
// picks the cache miss. A miss must never become a paid Textract call.
describe.skipIf(!dbUp)("demo projects are Textract cache-only", () => {
  it("cache miss on a demo project: no live AnalyzeDocument, the other methods still run", async () => {
    const { project } = await world(TEXTRACT_NO_TABLES);
    await publishDemoFixture(project.id);
    signedOut();
    const { status } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200);
    expect(h.analyzePageImage).not.toHaveBeenCalled();
    expect(h.methodTextractTables).toHaveBeenCalledWith(undefined, expect.anything());
    expect(h.methodOcrPositions).toHaveBeenCalled();
  });

  it("the same miss on a signed-in, non-demo project still calls Textract", async () => {
    const { user, project } = await world(TEXTRACT_NO_TABLES);
    asUser(user);
    await call(bodyFor(project.id));
    expect(h.analyzePageImage).toHaveBeenCalledTimes(1);
  });
});
