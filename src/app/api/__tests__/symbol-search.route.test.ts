// @vitest-environment node
// [refactor jul4 S024] CHARACTERIZATION for POST /api/symbol-search, written as THE FREEZE
// before the P1.5 migration onto services/symbol-search.ts (symbolSearch). The FIRST streaming
// (NDJSON) route to be folded. The matching ENGINES (@/lib/template-match, @/lib/lambda-cv) are
// NOT under test — they are mocked at the module boundary in both freeze and fold; this file
// freezes the ROUTE contract: the validation cascade, access matrix, pre-stream error strings,
// and the complete NDJSON stream transcripts (both Lambda and local branches). Frozen:
//   • VALIDATE-BEFORE-AUTH: field 400 ("Missing projectId, sourcePageNumber, or templateBbox",
//     TRUTHY check — projectId:0 / sourcePageNumber:0 wrongly trip it, FQ-13) → bbox 400
//     ("Invalid templateBbox") → resolveProjectAccess({dbId},{allowDemo:true}) (unknown→404
//     BEFORE auth; non-demo signed-out→401; cross-tenant→404; root bypass→200; demo public
//     read→200) → DEMO-ONLY gate assertDemoFeatureEnabled(companyId,"symbolSearch") (403,
//     fires even when dataUrl is null — gate precedes the dataUrl check; never fires for
//     non-demo) → !dataUrl 404 "Project not found" → 0-pages 400 "No pages to search"
//     (searchPages filtered against EXISTING pages) → fetch-fail 500 "Failed to fetch PDF".
//   • negative projectId → 404 "Not found" (query miss, no validation guard — diff-D DECLINED
//     at fold: adding Number.isInteger would flip this 404→400, unsanctioned).
//   • the catch-all 500 LEAKS err.message verbatim (route.ts:430) — pinned here at legacy;
//     flips to the shell's generic INTERNAL at fold (sanctioned diff B).
//   • in-stream contract at HTTP 200 (ZERO diff at fold, byte-identical): 3 progress variants
//     (Lambda dispatch page:0/pageIndex:0/matches:0/message:"Dispatching to Lambda workers...";
//     Lambda per-batch page:0/pageIndex:pagesDone/matches:cumulative/message:"Batch X/N
//     complete"; local real-page#/pageIndex:targetIndex+1/NO message key); TWO done shapes
//     (Lambda spreads failedPages ONLY when non-empty; local NEVER emits the key); match objects
//     DROP the engine's `scale` field; boundText null when OCR-bind found nothing vs key ABSENT
//     when OCR-bind threw (soft-fail swallow); in-stream {type:"error"} leaks err.message with
//     per-branch fallback literals ("Lambda symbol search failed" / "Symbol search failed").
//   • FQ-11: the Lambda try/catch fallback-to-local fires only PRE-stream (realistically the
//     readFile of the cropped template); a POST-stream Lambda failure is an in-stream error,
//     NOT a fallback.
//   • nondeterminism: match id `sm-${Date.now()}-${i}` (shape-asserted only), searchedAt
//     fresh-ISO at stream end.
//   • headers: Content-Type application/x-ndjson + Cache-Control no-cache (Transfer-Encoding
//     chunked is set by the route but may be normalized by the fetch Headers layer — asserted
//     defensively).
//   • malformed JSON / empty / null bodies: legacy unguarded `await req.json()` + destructure
//     at route.ts:27-28 (OUTSIDE the try) → raw rejection (framework 500 in prod); number/array
//     bodies destructure to undefined fields → "Missing…" 400. Flips at fold to the shell's
//     BAD_REQUEST/VALIDATION 400s (sanctioned diff E). Non-castable string projectId → pg
//     integer-cast rejection at route.ts:64 (outside the try) → raw rejection; flips to the
//     shell's generic INTERNAL 500 (diff B).
// Assertions tagged [S024 fold] flip in the fold commit (sanctioned diffs A/B/E).
import { describe, expect, inject, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// Handles for per-test re-mocking (vi.hoisted so the factories below can reference them).
const h = vi.hoisted(() => ({
  rasterizePage: vi.fn(),
  templateMatch: vi.fn(),
  isLambdaCvEnabled: vi.fn(),
  fanOutTemplateMatch: vi.fn(),
  bindOcrToShapes: vi.fn(),
  downloadFromS3: vi.fn(),
  readFile: vi.fn(),
  execFile: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/s3", () => ({
  getS3Url: vi.fn(() => "http://cdn.test/original.pdf"),
  downloadFromS3: h.downloadFromS3,
  uploadToS3: vi.fn(),
  deleteProjectFiles: vi.fn(),
}));
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: h.rasterizePage }));
vi.mock("@/lib/template-match", () => ({ templateMatch: h.templateMatch }));
// Full mock (not importOriginal): keeps the AWS SDK out of the graph. TEMPLATE_MATCH_BATCH_SIZE
// is pinned to its real default (parseInt(env||"1")=1) — the Lambda progress math depends on it.
vi.mock("@/lib/lambda-cv", () => ({
  isLambdaCvEnabled: h.isLambdaCvEnabled,
  fanOutTemplateMatch: h.fanOutTemplateMatch,
  TEMPLATE_MATCH_BATCH_SIZE: 1,
}));
vi.mock("@/lib/ocr-shape-binding", () => ({ bindOcrToShapes: h.bindOcrToShapes }));
// Partial mocks: keep everything real except the one function the route touches. The route's
// crop uses a DYNAMIC `await import("child_process")` (route.ts:123) — vi.mock intercepts
// dynamic imports too, so this same block covers freeze AND fold (where the crop lives in
// src/lib/template-crop.ts, still dynamically importing).
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: h.execFile,
}));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  readFile: h.readFile,
}));

import { POST } from "@/app/api/symbol-search/route";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
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

const BBOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
const body = (projectId: unknown, over: Record<string, unknown> = {}) => ({
  projectId,
  sourcePageNumber: 1,
  templateBbox: BBOX,
  ...over,
});
const call = (b: unknown) => POST(makeReq("/api/symbol-search", { body: b }));

/** Minimal buffer that satisfies the route's PNG-header dim reads (readUInt32BE(16)/(20)). */
function pngDims(w = 1000, hgt = 800): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(hgt, 20);
  return buf;
}

/** Drain an NDJSON stream Response into parsed lines (admin-reprocess-g3 precedent). */
async function drain(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.clearAllMocks(); // call counts must not leak across tests (toHaveBeenCalled assertions)
  h.execFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
  });
  h.readFile.mockResolvedValue(Buffer.from("tmpl"));
  h.rasterizePage.mockResolvedValue(pngDims());
  h.downloadFromS3.mockResolvedValue(pngDims());
  h.templateMatch.mockResolvedValue({ totalMatches: 0, results: [] });
  h.isLambdaCvEnabled.mockReturnValue(false);
  h.fanOutTemplateMatch.mockResolvedValue({ results: [], failedPages: [], warnings: [] });
  h.bindOcrToShapes.mockImplementation((shapes: unknown[]) => shapes.map(() => ({ boundText: null })));
  // FRESH Response per fetch — a Response body is single-use; mockResolvedValue would hand the
  // same consumed instance to a second fetch in the same test (→ spurious catch-all 500)
  h.fetch.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!dbUp)("POST /api/symbol-search", () => {
  // ── validation cascade (fires before auth — all signed-out, no/unknown project) ──────────

  it("missing/falsy field cascade: byte-exact 'Missing…' 400 before auth; FQ-13 truthy quirk (0 trips it)", async () => {
    signedOut();
    const cases: unknown[] = [
      { sourcePageNumber: 1, templateBbox: BBOX }, // no projectId
      { projectId: 999999999, templateBbox: BBOX }, // no sourcePageNumber
      { projectId: 999999999, sourcePageNumber: 1 }, // no templateBbox
      body(0), // projectId:0 falsy → "Missing" (FQ-13)
      body(999999999, { sourcePageNumber: 0 }), // sourcePageNumber:0 falsy → "Missing" (FQ-13)
    ];
    for (const b of cases) {
      const { status, body: resBody } = await readJson(await call(b));
      expect(status).toBe(400); // 400 wins over the would-be 404/401 — validate-before-auth
      expect(resBody).toEqual({ error: "Missing projectId, sourcePageNumber, or templateBbox" }); // [S024 fold: A] flips to {error:{code:"VALIDATION",message}}
    }
  });

  it("invalid templateBbox variants → 400; fires AFTER the missing-field check", async () => {
    signedOut();
    for (const bad of [
      { ...BBOX, x: 2 }, // out of [0,1]
      { ...BBOX, w: 0 }, // w<=0
      { ...BBOX, x: "a" }, // non-number
      { ...BBOX, h: -0.1 }, // negative
    ]) {
      const { status, body: resBody } = await readJson(await call(body(999999999, { templateBbox: bad })));
      expect(status).toBe(400);
      expect(resBody).toEqual({ error: "Invalid templateBbox" }); // [S024 fold: A] flips
    }
    // order pin: missing sourcePageNumber beats invalid bbox
    const order = await readJson(
      await call({ projectId: 999999999, templateBbox: { ...BBOX, x: 2 } }),
    );
    expect(order.body).toEqual({ error: "Missing projectId, sourcePageNumber, or templateBbox" }); // [S024 fold: A] flips
  });

  // ── access matrix (valid body; happy stack mocked so 200-paths stream) ────────────────────

  it("access matrix: demo signed-out 200-stream; non-demo signed-out 401; cross-tenant 404; root 200; unknown 404-before-auth; negative id 404", async () => {
    const demo = await createWorld({ isDemo: true });
    await createPage(demo.project.id, 1);
    signedOut();
    const demoRes = await call(body(demo.project.id));
    expect(demoRes.status).toBe(200); // public demo read (feature default-on)
    const demoLines = await drain(demoRes);
    expect(demoLines[demoLines.length - 1].type).toBe("done");

    const world = await createWorld();
    await createPage(world.project.id, 1);
    signedOut();
    const noAuth = await readJson(await call(body(world.project.id)));
    expect(noAuth.status).toBe(401);
    expect(noAuth.body).toEqual({ error: "Unauthorized" }); // [S024 fold: A] flips

    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await call(body(world.project.id)));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: "Not found" }); // [S024 fold: A] flips

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    const root = await call(body(world.project.id));
    expect(root.status).toBe(200); // root cross-company bypass
    await drain(root);

    signedOut();
    const unknown = await readJson(await call(body(999999999)));
    expect(unknown.status).toBe(404); // 404 BEFORE auth (engine order)
    expect(unknown.body).toEqual({ error: "Not found" }); // [S024 fold: A] flips

    // negative id = query miss → 404, NOT a validation 400 (diff-D deliberately DECLINED at fold)
    signedOut();
    const negative = await readJson(await call(body(-5)));
    expect(negative.status).toBe(404);
    expect(negative.body).toEqual({ error: "Not found" }); // [S024 fold: A] flips
  });

  // ── pre-stream state errors (verbatim strings; the leak pinned at legacy) ─────────────────
  // ⚠️ COVERAGE WAIVER — the `!project.dataUrl` → 404 "Project not found" branch (route :73-75)
  // is NOT directly frozen: dataUrl is notNull + UNIQUE (schema.ts:208), "" is the only falsy
  // value, and the single "" row is already owned by pages-textract-rerun.route.test.ts:88
  // (parallel files, shared DB — a second "" insert 23505s whichever file runs later). The
  // branch is a verbatim 3-line move at fold; the DETECTOR re-diff must verify it and the
  // gate-before-dataUrl ordering (:68 precedes :73) structurally.
  it("demo feature disabled → 403 verbatim (kill-switch read from companies.pipelineConfig.demo); flipping it on restores the stream", async () => {
    const company = await createCompany({ pipelineConfig: { demo: { symbolSearch: false } } });
    const user = await createUser(company.id);
    const project = await createProject(company.id, user.id, { isDemo: true });
    await createPage(project.id, 1);
    signedOut();
    const gated = await readJson(await call(body(project.id)));
    expect(gated.status).toBe(403);
    expect(gated.body).toEqual({
      error: "Symbol Search is disabled for demo users. Sign in to use this feature.",
    }); // does NOT flip at fold — the assertDemoFeatureEnabled NextResponse is returned VERBATIM
    // via the shell passthrough (demo-features.ts owns this 403's shape; labeling FQ-8 precedent,
    // services/labeling.ts:319). Flips only when demo-features itself migrates.

    await db
      .update(companies)
      .set({ pipelineConfig: { demo: { symbolSearch: true } } })
      .where(eq(companies.id, company.id));
    const enabled = await call(body(project.id));
    expect(enabled.status).toBe(200); // same request, gate now open → streams
    const lines = await drain(enabled);
    expect(lines[lines.length - 1].type).toBe("done");
  });

  it("zero pages → 400 'No pages to search'; searchPages filtered against EXISTING pages", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const none = await readJson(await call(body(project.id))); // no createPage at all
    expect(none.status).toBe(400);
    expect(none.body).toEqual({ error: "No pages to search" }); // [S024 fold: A] flips

    await createPage(project.id, 1);
    const filtered = await readJson(await call(body(project.id, { searchPages: [99] })));
    expect(filtered.status).toBe(400); // searchPages ∩ existing = ∅ → same 400
    expect(filtered.body).toEqual({ error: "No pages to search" }); // [S024 fold: A] flips
  });

  it("PDF fetch !ok → 500 'Failed to fetch PDF' (controlled message)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.fetch.mockResolvedValue(new Response("", { status: 500 }));
    const { status, body: resBody } = await readJson(await call(body(project.id)));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: "Failed to fetch PDF" }); // [S024 fold: A] flips (message PRESERVED — controlled string, not a leak-drop)
  });

  it("local path, ALL page images fail → 500 'No page images available'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.downloadFromS3.mockRejectedValue(new Error("s3 down"));
    // source raster (300 DPI) must succeed so setup passes; per-page fallback (200 DPI) fails
    h.rasterizePage.mockImplementation(async (_buf: Buffer, _page: number, dpi: number) => {
      if (dpi === 300) return pngDims();
      throw new Error("raster down");
    });
    const { status, body: resBody } = await readJson(await call(body(project.id)));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: "No page images available" }); // [S024 fold: A] flips (message PRESERVED)
  });

  it("catch-all 500 LEAKS err.message (legacy route.ts:430 — pinned; fold drops the leak)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.rasterizePage.mockRejectedValue(new Error("boom-raster-internals"));
    const { status, body: resBody } = await readJson(await call(body(project.id)));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: "boom-raster-internals" }); // [S024 fold: B] flips to {error:{code:"INTERNAL",message:"Internal server error"}} — leak dropped
  });

  // ── happy LOCAL transcript (full NDJSON; FQ-1/2/3/4/6/7c pins) ─────────────────────────────

  it("local happy: progress has NO message key, real page#, 1-based pageIndex; done drops scale, no failedPages key; headers pinned", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    await createPage(project.id, 2);
    asUser(user);
    h.templateMatch.mockImplementation(async (_opts: unknown, cbs?: { onProgress?: (p: unknown) => void }) => {
      cbs?.onProgress?.({ type: "progress", targetIndex: 0, targetPath: "t", matches: 2 });
      return {
        totalMatches: 1,
        results: [{ targetIndex: 0, bbox: [0.1, 0.1, 0.05, 0.05], confidence: 0.9, method: "template", scale: 1.0 }],
      };
    });

    const res = await call(body(project.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    // Transfer-Encoding is set by the route but the fetch Headers layer may normalize it away
    expect(["chunked", null]).toContain(res.headers.get("Transfer-Encoding"));

    const lines = await drain(res);
    expect(lines).toHaveLength(2);

    const progress = lines[0];
    // FQ-7c: local progress key-set has NO message key
    expect(Object.keys(progress).sort()).toEqual(["matches", "page", "pageIndex", "totalPages", "type"]);
    expect(progress).toEqual({ type: "progress", page: 1, pageIndex: 1, totalPages: 2, matches: 2 });

    const done = lines[1] as Record<string, unknown>;
    expect(done.type).toBe("done");
    expect(done.templateBbox).toEqual([0.1, 0.1, 0.2, 0.2]); // FQ-3 denormalized [x,y,w,h] echo of the REQUEST bbox
    expect(done.sourcePageNumber).toBe(1);
    expect(done.totalMatches).toBe(1);
    expect(done.pagesWithMatches).toEqual([1]);
    expect("failedPages" in done).toBe(false); // FQ-6: local NEVER emits the key
    expect(typeof done.searchedAt).toBe("string");
    expect(() => new Date(done.searchedAt as string).toISOString()).not.toThrow(); // FQ-2 fresh ISO

    const matches = done.matches as Record<string, unknown>[];
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(m.id).toMatch(/^sm-\d+-\d+$/); // FQ-1 nondeterministic — shape only
    expect(m.pageNumber).toBe(1);
    expect(m.bbox).toEqual([0.1, 0.1, 0.05, 0.05]);
    expect(m.confidence).toBe(0.9);
    expect(m.method).toBe("template");
    expect(m.boundText).toBeNull(); // OCR-bind ran, found nothing → explicit null (FQ-5)
    expect("scale" in m).toBe(false); // FQ-4: engine scale DROPPED
  });

  it("OCR-bind soft-fail: bindOcrToShapes throws → boundText key ABSENT, done still emitted at 200 (FQ-5)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.templateMatch.mockResolvedValue({
      totalMatches: 1,
      results: [{ targetIndex: 0, bbox: [0.1, 0.1, 0.05, 0.05], confidence: 0.9, method: "template", scale: 1.0 }],
    });
    h.bindOcrToShapes.mockImplementation(() => {
      throw new Error("ocr exploded");
    });
    const res = await call(body(project.id));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    const done = lines[lines.length - 1] as Record<string, unknown>;
    expect(done.type).toBe("done");
    const m = (done.matches as Record<string, unknown>[])[0];
    expect("boundText" in m).toBe(false); // swallow happened BEFORE the assignment loop
  });

  it("local in-stream engine error → HTTP 200 + {type:'error',message:<err.message>} (ZERO diff at fold)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.templateMatch.mockRejectedValue(new Error("local boom"));
    const res = await call(body(project.id));
    expect(res.status).toBe(200); // status already committed when the stream opened
    const lines = await drain(res);
    expect(lines[lines.length - 1]).toEqual({ type: "error", message: "local boom" });
  });

  // ── LAMBDA branch ──────────────────────────────────────────────────────────────────────────

  it("lambda happy: dispatch+batch progress variants (FQ-7a/7b/8), done WITH failedPages when non-empty, pageNumber via key-map, scale dropped", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    const pageKey = `${project.dataUrl}/pages/page_0001.png`;
    h.fanOutTemplateMatch.mockImplementation(
      async (opts: { onBatchComplete?: (idx: number, count: number) => void }) => {
        opts.onBatchComplete?.(0, 1);
        return {
          results: [{ targetIndex: 0, bbox: [0.2, 0.2, 0.05, 0.05], confidence: 0.8, method: "sift", scale: 1.1, pageS3Key: pageKey }],
          failedPages: [`${project.dataUrl}/pages/page_0002.png`],
          warnings: [],
        };
      },
    );

    const res = await call(body(project.id));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    expect(lines).toHaveLength(3);
    // FQ-7a dispatch: page 0, pageIndex 0, matches 0, message literal
    expect(lines[0]).toEqual({
      type: "progress", page: 0, pageIndex: 0, totalPages: 1, matches: 0,
      message: "Dispatching to Lambda workers...",
    });
    // FQ-7b per-batch: page 0, pageIndex = pagesDone (1 batch × size 1), cumulative matches
    expect(lines[1]).toEqual({
      type: "progress", page: 0, pageIndex: 1, totalPages: 1, matches: 1,
      message: "Batch 1/1 complete",
    });
    const done = lines[2] as Record<string, unknown>;
    expect(done.type).toBe("done");
    expect(done.failedPages).toEqual([`${project.dataUrl}/pages/page_0002.png`]); // FQ-6 spread when non-empty
    const m = (done.matches as Record<string, unknown>[])[0];
    expect(m.pageNumber).toBe(1); // mapped from pageS3Key
    expect(m.method).toBe("sift");
    expect("scale" in m).toBe(false); // FQ-4
  });

  it("lambda done WITHOUT failedPages key when empty (FQ-6 non-empty-only spread)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.fanOutTemplateMatch.mockResolvedValue({ results: [], failedPages: [], warnings: [] });
    const res = await call(body(project.id));
    const lines = await drain(res);
    const done = lines[lines.length - 1] as Record<string, unknown>;
    expect(done.type).toBe("done");
    expect("failedPages" in done).toBe(false);
  });

  it("lambda POST-stream failure → in-stream {type:'error'} at HTTP 200, NOT a local fallback (S023 §3b correction; ZERO diff)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.fanOutTemplateMatch.mockRejectedValue(new Error("lambda boom"));
    const res = await call(body(project.id));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    // dispatch progress already flushed, then the in-stream error — local path NEVER ran
    expect(lines[0]).toMatchObject({ type: "progress", message: "Dispatching to Lambda workers..." });
    expect(lines[lines.length - 1]).toEqual({ type: "error", message: "lambda boom" });
    expect(h.templateMatch).not.toHaveBeenCalled();
  });

  it("lambda PRE-stream failure (template readFile) → SILENT fallback to the LOCAL path (FQ-11)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.readFile.mockRejectedValueOnce(new Error("template read failed")); // route :143, before the stream exists
    const res = await call(body(project.id));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    const done = lines[lines.length - 1] as Record<string, unknown>;
    expect(done.type).toBe("done"); // local transcript, not an error line
    expect("failedPages" in done).toBe(false); // local shape
    expect(lines.every((l) => !("message" in l) || l.type !== "progress")).toBe(true); // no Lambda progress variants
    expect(h.fanOutTemplateMatch).not.toHaveBeenCalled(); // died before fan-out
    expect(h.templateMatch).toHaveBeenCalledTimes(1); // local engine ran
  });

  // ── body-parse family (diff E at fold) + non-castable dbId (diff B at fold) ───────────────

  it("malformed / empty / null bodies REJECT raw (legacy unguarded req.json + destructure, route.ts:27-28)", async () => {
    signedOut(); // rejection happens at the body parse, before auth could matter
    const raw = (payload: string) =>
      POST(
        new Request("http://test.local/api/symbol-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      );
    // [S024 fold: E] all three flip to enveloped 400s (BAD_REQUEST "Invalid JSON body" for
    // malformed; VALIDATION for empty/null via zLooseBody) — legacy rejects raw (prod 500).
    await expect(raw("{not json")).rejects.toThrow();
    await expect(raw("")).rejects.toThrow();
    await expect(raw("null")).rejects.toThrow();
  });

  it("number / array bodies destructure to undefined fields → legacy 'Missing…' 400 (status survives the fold, message drifts)", async () => {
    signedOut();
    const raw = (payload: string) =>
      POST(
        new Request("http://test.local/api/symbol-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      );
    for (const payload of ["5", "[1]"]) {
      const { status, body: resBody } = await readJson(await raw(payload));
      expect(status).toBe(400);
      expect(resBody).toEqual({ error: "Missing projectId, sourcePageNumber, or templateBbox" }); // [S024 fold: E] → VALIDATION 400, zod wording (cosmetic drift, status preserved)
    }
  });

  it("non-castable string projectId REJECTS raw (pg integer cast at route.ts:64, outside the try)", async () => {
    signedOut();
    // [S024 fold: B] flips to the shell's generic INTERNAL 500 (the uncaught pg throw is
    // caught by defineRoute; never leaks). If this proves flaky against pg, drop it and rely
    // on the unknown-int 404 for access coverage (design fallback).
    await expect(call(body("abc"))).rejects.toThrow();
  });

  // ── validate-before-auth composite pin ─────────────────────────────────────────────────────

  it("field-400 beats access-404: incomplete body + unknown project + signed-out → 400 'Missing…'", async () => {
    signedOut();
    const { status, body: resBody } = await readJson(
      await call({ projectId: 999999999, sourcePageNumber: 1 }), // no templateBbox
    );
    expect(status).toBe(400); // NOT the engine's 404
    expect(resBody).toEqual({ error: "Missing projectId, sourcePageNumber, or templateBbox" }); // [S024 fold: A] flips
  });
});
