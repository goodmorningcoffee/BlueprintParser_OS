// @vitest-environment node
// [refactor jul6 S029] CHARACTERIZATION for POST /api/table-structure, written as THE FREEZE
// before the P1.5 fold onto services/table-structure.ts. TATR cell-structure detection:
// python3/OpenCV crop (execFile, 10s timeout — near-twin of lib/template-crop.ts, dedup
// candidate for the P1 review, NOT consolidated in-fold) + lib/tatr-structure engine +
// Textract text-fill. Engines mocked; REAL DB via harness. Frozen:
//   • UQ-1 cascade: truthy field-400 ("Missing projectId, pageNumber, or regionBbox",
//     falsy-zero quirk; NOTE: NO bbox VALUE validation — only length===4; out-of-range
//     values proceed — do NOT add validation at fold) → resolveProjectAccess({dbId},
//     {allowDemo:true}) → project.isDemo gate "tableParse" (SAME feature key as
//     table-parse) flat 403. req.json() pre-try → malformed/empty/null + non-castable
//     dbId REJECT RAW at legacy.
//   • UQ-2 the PDF-download INNER catch leaks: "Failed to fetch PDF: ${err.message}" flat
//     500. SANCTIONED AT FOLD (pre-flagged S026 recon; owner-precedent = symbol-search):
//     → ApiError("INTERNAL","Failed to fetch PDF") — suffix DROPPED, prefix kept; the
//     surviving string is byte-identical to S024's already-pinned message (harmonizes).
//   • UQ-3 THE 200-WITH-ERROR-KEY SOFT PATH: tatrResult.error → HTTP 200 body
//     {error:<engine msg>, cells:[], rows:[], columns:[], confidence:0} — a SUCCESS-path
//     body shape (in-band error, in-stream-error analog). NEVER flips to the envelope.
//   • UQ-4 pipeline: rasterizePage(pdf, pageNumber, 200); crop rect = Math.round of
//     bbox×dims (w/h floored at 1); python3 -c <script> [json] via execFileAsync w/
//     timeout 10000; cropped read via DYNAMIC import("fs/promises").readFile (mock seam);
//     detectTableStructure(cropped, confidenceThreshold ?? 0.5 — passthrough pinned).
//   • UQ-5 remap: MinMax cell bboxes offset+coord*regionSize (all 4). Text-fill ONLY when
//     the page row has textractData: word-CENTER-in-cell test, x-sorted, join " ";
//     no page row → TATR's own cell text left untouched.
//   • UQ-6 tempDir: mkdtemp pre-try; try/CATCH/FINALLY-rm at legacy. The fold KEEPS
//     try/FINALLY (rm always runs — safe here, nothing escapes the try) and retires only
//     the CATCH (outer leak "Table structure detection failed" fallback → diff B).
// Assertions tagged [S029 fold] flip in the fold commit (sanctioned A/B/E + UQ-2 only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  downloadFromS3: vi.fn(),
  rasterizePage: vi.fn(),
  detectTableStructure: vi.fn(),
  execFile: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("@/lib/s3", () => ({
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  downloadFromS3: h.downloadFromS3,
  uploadToS3: vi.fn(),
  deleteProjectFiles: vi.fn(),
}));
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: h.rasterizePage }));
vi.mock("@/lib/tatr-structure", () => ({ detectTableStructure: h.detectTableStructure }));
// Partial mocks (S024 idiom): keep everything real except what the route touches.
// vi.mock intercepts the DYNAMIC import("fs/promises") for readFile too.
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: h.execFile,
}));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  writeFile: h.writeFile,
  rm: h.rm,
  readFile: h.readFile,
}));

import { POST } from "@/app/api/table-structure/route";
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

const BBOX: [number, number, number, number] = [0.1, 0.2, 0.5, 0.6]; // w=0.4 h=0.4
const TATR_OK = {
  cells: [
    { bbox: [0.25, 0.25, 0.75, 0.75] as [number, number, number, number], row: 0, col: 0, text: "tatr-text" },
  ],
  rows: [{ y: 0.5 }],
  columns: [{ x: 0.5 }],
  confidence: 0.9,
};
const WORDS = [
  // center (0.25, 0.4) → inside the remapped cell [0.2,0.3,0.4,0.5]; x=0.2 sorts SECOND
  { text: "beta", bbox: [0.2, 0.375, 0.1, 0.05] },
  // center (0.22, 0.35) → inside; x=0.17 sorts FIRST
  { text: "alpha", bbox: [0.17, 0.325, 0.1, 0.05] },
  // center (0.9, 0.9) → outside
  { text: "outside", bbox: [0.85, 0.875, 0.1, 0.05] },
];

const call = (b: unknown) => POST(makeReq("/api/table-structure", { body: b }));
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

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.downloadFromS3.mockResolvedValue(Buffer.from("pdf"));
  h.rasterizePage.mockResolvedValue(pngDims());
  h.detectTableStructure.mockResolvedValue({ ...TATR_OK, cells: TATR_OK.cells.map((c) => ({ ...c })) });
  h.execFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
  });
  h.readFile.mockResolvedValue(Buffer.from("cropped"));
  h.writeFile.mockResolvedValue(undefined);
  h.rm.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("POST /api/table-structure — cascade (UQ-1)", () => {
  it("truthy field 400 (falsy-zero; length!==4); NO bbox-value validation exists", async () => {
    for (const b of [bodyFor(0), { projectId: 1, regionBbox: BBOX }, bodyFor(1, { regionBbox: [0.1] })]) {
      const { status, body } = await readJson(await call(b));
      expect(status).toBe(400);
      // [S029 fold: A applied — was flat]
      expect(body).toEqual({
        error: { code: "VALIDATION", message: "Missing projectId, pageNumber, or regionBbox" },
      });
    }
  });

  it("malformed / empty / 'null' bodies + non-castable dbId: raw rejections (pre-try)", async () => {
    // [S029 fold: E — malformed→BAD_REQUEST 400, empty/null→VALIDATION 400; B — pg-cast→generic 500]
    const mk = (raw: string | undefined) =>
      new Request("http://test.local/api/table-structure", {
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
    r = await readJson(await call(bodyFor("not-a-number")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S029 fold: E+B applied]
  });

  it("access 401/404/negative-404 + demo gate 'tableParse' flat 403 / default-on 200", async () => {
    const { project } = await world();
    let r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S029 fold: A applied]
    const other = await createCompany();
    asUser(await createUser(other.id));
    r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S029 fold: A applied]
    r = await readJson(await call(bodyFor(-5)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // int-guard DECLINED [S029 fold: A applied]
    signedOut();
    const demo = await world({ isDemo: true });
    await db.update(companies).set({ pipelineConfig: { demo: { tableParse: false } } }).where(eq(companies.id, demo.company.id));
    r = await readJson(await call(bodyFor(demo.project.id)));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Table/Schedule Parse is disabled for demo users. Sign in to use this feature." }); // flat, never flips
    await db.update(companies).set({ pipelineConfig: {} }).where(eq(companies.id, demo.company.id));
    r = await readJson(await call(bodyFor(demo.project.id)));
    expect(r.status).toBe(200); // DEFAULT_ON.tableParse; anon demo read via allowDemo
  });
});

async function world(projectOver: Record<string, unknown> = {}) {
  return createWorld(projectOver);
}

describe.skipIf(!dbUp)("pipeline (UQ-2/3/4/5/6)", () => {
  it("happy: rasterize(pdf,1,200), python crop rect, TATR w/ default 0.5, remap + text-fill sorted", async () => {
    const { user, project } = await world();
    await createPage(project.id, 1, { textractData: { words: WORDS, lines: [] } as never });
    asUser(user);
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200);
    expect(h.rasterizePage).toHaveBeenCalledWith(Buffer.from("pdf"), 1, 200);
    // crop rect: [0.1,0.2,0.5,0.6] on 1000x800 → x=100 y=160 w=400 h=320
    const [cmd, args, opts] = h.execFile.mock.calls[0];
    expect(cmd).toBe("python3");
    expect(args[0]).toBe("-c");
    const cfg = JSON.parse(args[2]);
    expect(cfg).toMatchObject({ x: 100, y: 160, w: 400, h: 320 });
    expect(cfg.src.endsWith("page.png")).toBe(true);
    expect(cfg.dst.endsWith("cropped.png")).toBe(true);
    expect(opts).toMatchObject({ timeout: 10000 });
    expect(h.detectTableStructure).toHaveBeenCalledWith(Buffer.from("cropped"), 0.5); // default pinned
    // remap: [0.25,0.25,0.75,0.75] in region [0.1,0.2→0.5,0.6] (w=h=0.4) → [0.2,0.3,0.4,0.5]
    const cell = body.cells[0];
    expect(cell.bbox[0]).toBeCloseTo(0.2, 10);
    expect(cell.bbox[1]).toBeCloseTo(0.3, 10);
    expect(cell.bbox[2]).toBeCloseTo(0.4, 10);
    expect(cell.bbox[3]).toBeCloseTo(0.5, 10);
    expect(cell.text).toBe("alpha beta"); // center-in-cell filter + x-sort + join " "
    expect(body.rows).toEqual(TATR_OK.rows);
    expect(body.columns).toEqual(TATR_OK.columns);
    expect(body.confidence).toBe(0.9);
    expect(h.rm).toHaveBeenCalledTimes(1); // finally: tempDir cleaned (UQ-6)
  });

  it("confidenceThreshold passthrough; no page row → TATR's own cell text untouched", async () => {
    const { user, project } = await world(); // no page row created
    asUser(user);
    const { body } = await readJson(await call(bodyFor(project.id, { confidenceThreshold: 0.8 })));
    expect(h.detectTableStructure).toHaveBeenCalledWith(Buffer.from("cropped"), 0.8);
    expect(body.cells[0].text).toBe("tatr-text"); // UQ-5: untouched without textractData
  });

  it("UQ-3: TATR error → HTTP 200 with the in-band error body — NEVER flips", async () => {
    const { user, project } = await world();
    asUser(user);
    h.detectTableStructure.mockResolvedValue({ error: "TATR service unavailable", cells: [], rows: [], columns: [], confidence: 0 });
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200);
    expect(body).toEqual({ error: "TATR service unavailable", cells: [], rows: [], columns: [], confidence: 0 });
    expect(h.rm).toHaveBeenCalledTimes(1); // finally still runs on the soft path
  });

  it("UQ-2: pdf download fail → inner catch LEAKS 'Failed to fetch PDF: <msg>' flat 500", async () => {
    // [S029 fold: UQ-2 sanction — ApiError("INTERNAL","Failed to fetch PDF"): suffix dropped,
    // prefix kept, harmonizing with the S024-pinned string]
    const { user, project } = await world();
    asUser(user);
    h.downloadFromS3.mockRejectedValue(new Error("s3 exploded"));
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(500);
    // [S029 fold: UQ-2 sanction applied — suffix DROPPED, message now byte-identical to the
    // S024-pinned string; surfaces as ApiError INTERNAL via defineRoute:254]
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Failed to fetch PDF" } });
    expect(h.rm).toHaveBeenCalledTimes(1); // finally runs even on the throw path
  });

  it("pipeline throw (rasterize) → outer catch LEAKS err.message flat 500; finally still rm's", async () => {
    // [S029 fold: B — shell generic INTERNAL 500; leak dropped; finally KEPT]
    const { user, project } = await world();
    asUser(user);
    h.rasterizePage.mockRejectedValue(new Error("raster died"));
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S029 fold: B applied]
    expect(h.rm).toHaveBeenCalledTimes(1); // finally KEPT
  });
});
