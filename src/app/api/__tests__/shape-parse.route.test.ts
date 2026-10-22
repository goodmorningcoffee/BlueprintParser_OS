// @vitest-environment node
// [refactor jul5 S028] CHARACTERIZATION for POST /api/shape-parse, written as THE FREEZE
// before the P1.5 fold onto services/shape-parse.ts. Direct symbol-search (S024) sibling:
// same lambda-cv fan-out / bindOcrToShapes / dynamic-sharp surface, but kind:"json" (no
// stream). Engines mocked at module seams (keynotes.extractKeynotes, ocr-shape-binding,
// lambda-cv, s3, pdf-rasterize, sharp); REAL DB via harness. Frozen:
//   • SQ-1 cascade: "Missing projectId" (truthy, falsy-zero) → "Missing pageNumber (or set
//     scanAll: true)" (fires when !scanAll && !pageNumber; pageNumber:0 trips it) →
//     resolveProjectAccess({dbId},{allowDemo:true}) → project.isDemo gate
//     assertDemoFeatureEnabled(companyId,"keynoteParse") flat 403 → !dataUrl 404 "Project
//     not found" → scanAll | single-page branch. req.json() OUTSIDE any try → malformed/
//     empty/null bodies + non-castable dbIds REJECT RAW at legacy.
//   • ⚠️ SQ-2 the !dataUrl→404 branch is UNTESTABLE here (S024 waiver class: data_url is
//     notNull+UNIQUE; the "" sentinel row is owned by pages-textract-rerun.route.test.ts)
//     — structural verification only, carried to the P1 review like symbol-search's.
//   • SQ-3 scanAll Lambda branch: keynotes = TRIMMED {shape,text,bbox,contour,pageNumber}
//     but byPage[pn] = the RAW fan-out result objects (incl. pageS3Key — asymmetry, frozen);
//     failedPages/warnings spread ONLY when non-empty; totalPages always; unknown pageS3Key
//     → pn 0. Local branch: byPage[p] = engine keynotes AS-IS (no pageNumber added),
//     allKeynotes = {...k, pageNumber}; per-page failure → warnings "Page N failed" (loop
//     continues); warnings key absent-when-empty (length>0 ? warnings : undefined — JSON
//     drops undefined). scanAll no-pages → {keynotes:[],byPage:{},warnings:["No pages found"]}.
//   • SQ-4 single-page: padded page_NNNN.png; png-fail → original.pdf + rasterizePage(pdf,
//     pageNumber, 300) fallback; both-fail → CONTROLLED "Failed to load page image" 500
//     (message KEPT at fold as ApiError INTERNAL — defineRoute's catch forwards any ApiError's
//     message, the DOCUMENTED contract in envelope.ts, S024-pinned pattern); "Page image unavailable"
//     defensive 500 likely unreachable (kept).
//   • SQ-5 regionBbox (MinMax): sharp crop only when cropW>10 && cropH>10, else SILENT
//     full-page (offsets 0/0/1/1); crop throw → warn + full page. Remap: offset +
//     coord*regionSize on all 4 bbox coords AND contour points.
//   • SQ-6 boundText: bindOcrToShapes runs ONLY when the page row has textractData —
//     enriched carries boundText (?? null); otherwise the key is ENTIRELY ABSENT (FQ-5
//     analog); bind throw → soft-fail, key absent, 200. bindOcrToShapes input shape:
//     {pageNumber,bbox,shapeType,confidence:0.9,method:"shape-parse"}.
//   • legacy catch-alls LEAK: scanAll → "All-pages scan failed: ${msg}" 500; single-page →
//     "Shape parse failed: ${msg}" 500 (flip to generic INTERNAL at fold, diff B).
// Assertions tagged [S028 fold] flip in the fold commit (sanctioned diffs A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  extractKeynotes: vi.fn(),
  bindOcrToShapes: vi.fn(),
  isLambdaCvEnabled: vi.fn(),
  fanOutShapeParse: vi.fn(),
  downloadFromS3: vi.fn(),
  rasterizePage: vi.fn(),
  sharp: vi.fn(),
  sharpExtract: vi.fn(),
}));

vi.mock("@/lib/keynotes", () => ({ extractKeynotes: h.extractKeynotes }));
vi.mock("@/lib/ocr-shape-binding", () => ({ bindOcrToShapes: h.bindOcrToShapes }));
// Full mock keeps the AWS SDK out of the graph (S024 precedent)
vi.mock("@/lib/lambda-cv", () => ({
  isLambdaCvEnabled: h.isLambdaCvEnabled,
  fanOutShapeParse: h.fanOutShapeParse,
}));
vi.mock("@/lib/s3", () => ({
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  downloadFromS3: h.downloadFromS3,
  uploadToS3: vi.fn(),
  deleteProjectFiles: vi.fn(),
}));
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: h.rasterizePage }));
vi.mock("sharp", () => ({ default: h.sharp }));

import { POST } from "@/app/api/shape-parse/route";
import {
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;

const KEYNOTE = {
  shape: "circle",
  text: "A1",
  bbox: [0.5, 0.5, 0.6, 0.6] as [number, number, number, number],
  contour: [[0.5, 0.5], [0.6, 0.6]] as [number, number][],
};
const TEXTRACT = { words: [{ text: "A1" }], lines: [] };

const call = (b: unknown) => POST(makeReq("/api/shape-parse", { body: b }));

async function world(projectOver: Record<string, unknown> = {}) {
  const w = await createWorld(projectOver);
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.extractKeynotes.mockResolvedValue({ keynotes: [KEYNOTE], warnings: [] });
  h.bindOcrToShapes.mockImplementation((shapes: unknown[]) => shapes.map(() => ({ boundText: "A1 bound" })));
  h.isLambdaCvEnabled.mockReturnValue(false);
  h.fanOutShapeParse.mockResolvedValue({ results: [], failedPages: [], warnings: [] });
  h.downloadFromS3.mockResolvedValue(Buffer.from("png"));
  h.rasterizePage.mockResolvedValue(Buffer.from("rasterized"));
  h.sharpExtract.mockReturnValue({ png: () => ({ toBuffer: async () => Buffer.from("cropped") }) });
  h.sharp.mockImplementation(() => ({
    metadata: async () => ({ width: 1000, height: 800 }),
    extract: h.sharpExtract,
  }));
});

describe.skipIf(!dbUp)("POST /api/shape-parse — cascade (SQ-1)", () => {
  it("'Missing projectId' 400 (truthy, falsy-zero) then 'Missing pageNumber (or set scanAll: true)'", async () => {
    for (const b of [{}, { projectId: 0, pageNumber: 1 }]) {
      const { status, body } = await readJson(await call(b));
      expect(status).toBe(400);
      expect(body).toEqual({ error: { code: "VALIDATION", message: "Missing projectId" } }); // [S028 fold: A applied]
    }
    for (const b of [{ projectId: 1 }, { projectId: 1, pageNumber: 0 }, { projectId: 1, scanAll: false }]) {
      const { status, body } = await readJson(await call(b));
      expect(status).toBe(400);
      expect(body).toEqual({
        error: { code: "VALIDATION", message: "Missing pageNumber (or set scanAll: true)" },
      }); // [S028 fold: A applied]
    }
  });

  it("malformed / empty / 'null' bodies → clean 400s; non-castable projectId → generic 500", async () => {
    // [S028 fold: E+B applied — all four rejected RAW at legacy (pre-try req.json/pg-cast)]
    const mk = (raw: string | undefined) =>
      new Request("http://test.local/api/shape-parse", {
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
    r = await readJson(await call({ projectId: "not-a-number", pageNumber: 1 }));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  it("access: signed-out 401 / cross-tenant 404 / negative 404 (int-guard DECLINED)", async () => {
    const { project } = await world();
    let r = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S028 fold: A applied]
    const other = await createCompany();
    asUser(await createUser(other.id));
    r = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S028 fold: A applied]
    r = await readJson(await call({ projectId: -5, pageNumber: 1 }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S028 fold: A applied]
  });

  it("demo gate: keynoteParse disabled → FLAT 403 (does NOT flip); default-on → 200 anon read", async () => {
    const { company, project } = await world({ isDemo: true });
    await db.update(companies).set({ pipelineConfig: { demo: { keynoteParse: false } } }).where(eq(companies.id, company.id));
    let r = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Keynote Parse is disabled for demo users. Sign in to use this feature." });
    await db.update(companies).set({ pipelineConfig: {} }).where(eq(companies.id, company.id));
    r = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(r.status).toBe(200); // DEFAULT_ON.keynoteParse = true; allowDemo public read
  });
});

describe.skipIf(!dbUp)("single-page mode (SQ-4/5/6)", () => {
  it("happy WITH textract: identity remap (no bbox), boundText attached, bind input shape pinned", async () => {
    const { user, project } = await world();
    await createPage(project.id, 3, { textractData: TEXTRACT as never });
    asUser(user);
    const { status, body } = await readJson(await call({ projectId: project.id, pageNumber: 3 }));
    expect(status).toBe(200);
    const key = h.downloadFromS3.mock.calls[0][0] as string;
    expect(key.endsWith("/pages/page_0003.png")).toBe(true); // padded
    expect(h.bindOcrToShapes).toHaveBeenCalledWith(
      [{ pageNumber: 3, bbox: KEYNOTE.bbox, shapeType: "circle", confidence: 0.9, method: "shape-parse" }],
      { 3: TEXTRACT },
    );
    // owner 2026-10-21: reprocess must persist — a non-demo run is now stored, and the response
    // carries what was stored (`persisted`, pinned in shape-parse-persistence.route.test.ts).
    const { persisted, ...rest } = body as { persisted: { pages: Record<string, unknown> } };
    expect(rest).toEqual({
      keynotes: [{ ...KEYNOTE, boundText: "A1 bound" }],
      warnings: [],
    });
    expect(persisted.pages).toEqual({ 3: [KEYNOTE] });
    expect(h.sharpExtract).not.toHaveBeenCalled(); // no regionBbox → no crop
  });

  it("NO page row → boundText key ENTIRELY ABSENT (SQ-6); bind throw → soft-fail absent too", async () => {
    const { user, project } = await world();
    asUser(user);
    let r = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(r.status).toBe(200);
    expect(h.bindOcrToShapes).not.toHaveBeenCalled();
    expect("boundText" in r.body.keynotes[0]).toBe(false);
    // bind throws — soft-fail keeps 200 and drops the key
    await createPage(project.id, 1, { textractData: TEXTRACT as never });
    h.bindOcrToShapes.mockImplementation(() => {
      throw new Error("bind died");
    });
    r = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(r.status).toBe(200);
    expect("boundText" in r.body.keynotes[0]).toBe(false);
  });

  it("regionBbox crop + remap math (offset + coord*regionSize on bbox AND contour)", async () => {
    const { user, project } = await world();
    asUser(user);
    const region = [0.2, 0.2, 0.6, 0.7]; // w=0.4 h=0.5
    const { body } = await readJson(await call({ projectId: project.id, pageNumber: 1, regionBbox: region }));
    expect(h.sharpExtract).toHaveBeenCalledWith({ left: 200, top: 160, width: 400, height: 400 });
    expect(h.extractKeynotes).toHaveBeenCalledWith(Buffer.from("cropped"));
    const k = body.keynotes[0];
    expect(k.bbox[0]).toBeCloseTo(0.2 + 0.5 * 0.4, 10);
    expect(k.bbox[1]).toBeCloseTo(0.2 + 0.5 * 0.5, 10);
    expect(k.bbox[2]).toBeCloseTo(0.2 + 0.6 * 0.4, 10);
    expect(k.bbox[3]).toBeCloseTo(0.2 + 0.6 * 0.5, 10);
    expect(k.contour[0][0]).toBeCloseTo(0.2 + 0.5 * 0.4, 10);
    expect(k.contour[1][1]).toBeCloseTo(0.2 + 0.6 * 0.5, 10);
  });

  it("sub-10px crop silently skipped → full page identity remap (SQ-5)", async () => {
    const { user, project } = await world();
    asUser(user);
    // [0.1,0.1,0.105,0.105] on 1000x800 → cropW=5, cropH=4 → skip
    const { body } = await readJson(
      await call({ projectId: project.id, pageNumber: 1, regionBbox: [0.1, 0.1, 0.105, 0.105] }),
    );
    expect(h.sharpExtract).not.toHaveBeenCalled();
    expect(body.keynotes[0].bbox).toEqual(KEYNOTE.bbox); // identity remap
  });

  it("png-fail → pdf+rasterize(300) fallback; both-fail → CONTROLLED 500 'Failed to load page image'", async () => {
    const { user, project } = await world();
    asUser(user);
    h.downloadFromS3.mockImplementation(async (key: string) => {
      if (key.endsWith(".png")) throw new Error("no png");
      return Buffer.from("pdf");
    });
    let r = await readJson(await call({ projectId: project.id, pageNumber: 2 }));
    expect(r.status).toBe(200);
    expect(h.rasterizePage).toHaveBeenCalledWith(Buffer.from("pdf"), 2, 300);
    h.downloadFromS3.mockRejectedValue(new Error("s3 dead"));
    r = await readJson(await call({ projectId: project.id, pageNumber: 2 }));
    expect(r.status).toBe(500);
    // [S028 fold: A applied — CONTROLLED message KEPT] ApiError("INTERNAL",msg) SURFACES via
    // defineRoute's catch — the DOCUMENTED contract in envelope.ts's ApiError JSDoc, S024 pin class
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Failed to load page image" } });
  });

  it("engine throw → generic INTERNAL 500, leak dropped", async () => {
    // [S028 fold: B applied — legacy leaked {error:"Shape parse failed: cv exploded"} flat]
    const { user, project } = await world();
    asUser(user);
    h.extractKeynotes.mockRejectedValue(new Error("cv exploded"));
    const { status, body } = await readJson(await call({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
});

describe.skipIf(!dbUp)("scanAll mode (SQ-3)", () => {
  it("no pages → {keynotes:[], byPage:{}, warnings:['No pages found']}", async () => {
    const { user, project } = await world();
    asUser(user);
    const { status, body } = await readJson(await call({ projectId: project.id, scanAll: true }));
    expect(status).toBe(200);
    expect(body).toEqual({ keynotes: [], byPage: {}, warnings: ["No pages found"] });
  });

  it("Lambda ON: trimmed keynotes vs RAW byPage asymmetry; conditional failedPages/warnings", async () => {
    const { user, project } = await world();
    await createPage(project.id, 1);
    await createPage(project.id, 2);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    const raw1 = {
      pageS3Key: `${project.dataUrl}/pages/page_0001.png`,
      shape: "circle", text: "A1", bbox: [0.1, 0.1, 0.2, 0.2], contour: [[0.1, 0.1]],
      extraEngineField: "kept-in-byPage",
    };
    h.fanOutShapeParse.mockResolvedValue({ results: [raw1], failedPages: [], warnings: [] });
    let r = await readJson(await call({ projectId: project.id, scanAll: true }));
    expect(h.fanOutShapeParse).toHaveBeenCalledWith({
      pageS3Keys: [
        `${project.dataUrl}/pages/page_0001.png`,
        `${project.dataUrl}/pages/page_0002.png`,
      ],
    });
    // keynotes = TRIMMED {shape,text,bbox,contour,pageNumber}; byPage = RAW results (frozen asymmetry)
    expect(r.body.keynotes).toEqual([
      { shape: "circle", text: "A1", bbox: [0.1, 0.1, 0.2, 0.2], contour: [[0.1, 0.1]], pageNumber: 1 },
    ]);
    expect(r.body.byPage).toEqual({ 1: [raw1] });
    expect(r.body.totalPages).toBe(2);
    expect("failedPages" in r.body).toBe(false); // spread only when non-empty
    expect("warnings" in r.body).toBe(false);
    // non-empty spreads + unknown pageS3Key → pageNumber 0
    h.fanOutShapeParse.mockResolvedValue({
      results: [{ ...raw1, pageS3Key: "unknown/key.png" }],
      failedPages: ["page_0002"],
      warnings: ["lambda slow"],
    });
    r = await readJson(await call({ projectId: project.id, scanAll: true }));
    expect(r.body.keynotes[0].pageNumber).toBe(0);
    expect(r.body.failedPages).toEqual(["page_0002"]);
    expect(r.body.warnings).toEqual(["lambda slow"]);
  });

  it("Lambda OFF local loop: per-page soft-fail → 'Page N failed' warning; byPage = engine keynotes as-is", async () => {
    const { user, project } = await world();
    await createPage(project.id, 1);
    await createPage(project.id, 2);
    asUser(user);
    h.extractKeynotes
      .mockResolvedValueOnce({ keynotes: [KEYNOTE], warnings: ["blur"] })
      .mockRejectedValueOnce(new Error("page 2 cv died"));
    const { body } = await readJson(await call({ projectId: project.id, scanAll: true }));
    expect(body.keynotes).toEqual([{ ...KEYNOTE, pageNumber: 1 }]); // pageNumber added here...
    expect(body.byPage).toEqual({ 1: [KEYNOTE] }); // ...but NOT in byPage (frozen)
    expect(body.totalPages).toBe(2);
    expect(body.warnings).toEqual(["blur", "Page 2 failed"]);
  });

  it("scanAll fan-out throw → generic INTERNAL 500, leak dropped", async () => {
    // [S028 fold: B applied — legacy leaked {error:"All-pages scan failed: lambda dead"} flat,
    // incl. fanOutShapeParse's env-var messages]
    const { user, project } = await world();
    await createPage(project.id, 1);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.fanOutShapeParse.mockRejectedValue(new Error("lambda dead"));
    const { status, body } = await readJson(await call({ projectId: project.id, scanAll: true }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
});
