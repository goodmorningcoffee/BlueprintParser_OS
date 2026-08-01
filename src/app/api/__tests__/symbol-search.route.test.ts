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
  publishDemoFixture,
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
      expect(resBody).toEqual({
        error: { code: "VALIDATION", message: "Missing projectId, sourcePageNumber, or templateBbox" },
      }); // [S024 fold: A] flipped
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
      expect(resBody).toEqual({ error: { code: "VALIDATION", message: "Invalid templateBbox" } }); // [S024 fold: A] flipped
    }
    // order pin: missing sourcePageNumber beats invalid bbox
    const order = await readJson(
      await call({ projectId: 999999999, templateBbox: { ...BBOX, x: 2 } }),
    );
    expect(order.body).toEqual({
      error: { code: "VALIDATION", message: "Missing projectId, sourcePageNumber, or templateBbox" },
    }); // [S024 fold: A] flipped
  });

  // ── access matrix (valid body; happy stack mocked so 200-paths stream) ────────────────────

  it("access matrix: demo signed-out 200-stream; non-demo signed-out 401; cross-tenant 404; root 200; unknown 404-before-auth; negative id 404", async () => {
    const demo = await createWorld();
    await createPage(demo.project.id, 1);
    await publishDemoFixture(demo.project.id);
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
    expect(noAuth.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S024 fold: A] flipped

    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await call(body(world.project.id)));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S024 fold: A] flipped

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    const root = await call(body(world.project.id));
    expect(root.status).toBe(200); // root cross-company bypass
    await drain(root);

    signedOut();
    const unknown = await readJson(await call(body(999999999)));
    expect(unknown.status).toBe(404); // 404 BEFORE auth (engine order)
    expect(unknown.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S024 fold: A] flipped

    // negative id = query miss → 404, NOT a validation 400 (diff-D deliberately DECLINED at fold)
    signedOut();
    const negative = await readJson(await call(body(-5)));
    expect(negative.status).toBe(404);
    expect(negative.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S024 fold: A] flipped
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
    const project = await createProject(company.id, user.id);
    await createPage(project.id, 1);
    await publishDemoFixture(project.id);
    signedOut();
    const gated = await readJson(await call(body(project.id)));
    expect(gated.status).toBe(403);
    expect(gated.body).toEqual({
      error: "Symbol Search is disabled for demo users. Sign in to use this feature.",
    }); // does NOT flip at fold — the assertDemoFeatureEnabled NextResponse is returned VERBATIM
    // via the shell passthrough (demo-features.ts owns this 403's shape; labeling's FQ-8 was the
    // precedent and is now retired). Flips only when demo-features itself migrates.

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
    expect(none.body).toEqual({ error: { code: "VALIDATION", message: "No pages to search" } }); // [S024 fold: A] flipped

    await createPage(project.id, 1);
    const filtered = await readJson(await call(body(project.id, { searchPages: [99] })));
    expect(filtered.status).toBe(400); // searchPages ∩ existing = ∅ → same 400
    expect(filtered.body).toEqual({ error: { code: "VALIDATION", message: "No pages to search" } }); // [S024 fold: A] flipped
  });

  it("private S3 PDF read failure → 500 'Failed to fetch PDF' (controlled message)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.downloadFromS3.mockRejectedValueOnce(new Error("private S3 unavailable"));
    const { status, body: resBody } = await readJson(await call(body(project.id)));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: { code: "INTERNAL", message: "Failed to fetch PDF" } }); // [S024 fold: A] flipped — message PRESERVED (controlled string, not a leak-drop; pins the envelope.ts:42 doc/code contradiction — the shell DOES surface INTERNAL ApiError messages)
  });

  it("local path, ALL page images fail → 500 'No page images available'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.downloadFromS3
      .mockResolvedValueOnce(pngDims()) // original.pdf
      .mockRejectedValue(new Error("s3 down")); // every page image
    // source raster (300 DPI) must succeed so setup passes; per-page fallback (200 DPI) fails
    h.rasterizePage.mockImplementation(async (_buf: Buffer, _page: number, dpi: number) => {
      if (dpi === 300) return pngDims();
      throw new Error("raster down");
    });
    const { status, body: resBody } = await readJson(await call(body(project.id)));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: { code: "INTERNAL", message: "No page images available" } }); // [S024 fold: A] flipped — message PRESERVED (same contradiction pin as "Failed to fetch PDF")
  });

  it("catch-all 500 LEAKS err.message (legacy route.ts:430 — pinned; fold drops the leak)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.rasterizePage.mockRejectedValue(new Error("boom-raster-internals"));
    const { status, body: resBody } = await readJson(await call(body(project.id)));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S024 fold: B] flipped — err.message leak DROPPED (real cause logged server-side with requestId)
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

  // [DETECTOR closer] boundText NON-NULL propagation — the beforeEach mock returns null for
  // every shape; this pins the real-string path through the assignment loop (FQ-5's third leg).
  it("boundText propagates a real OCR string when bindOcrToShapes finds text", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.templateMatch.mockResolvedValue({
      totalMatches: 1,
      results: [{ targetIndex: 0, bbox: [0.1, 0.1, 0.05, 0.05], confidence: 0.9, method: "template", scale: 1.0 }],
    });
    h.bindOcrToShapes.mockImplementation((shapes: unknown[]) => shapes.map(() => ({ boundText: "D-101" })));
    const res = await call(body(project.id));
    const lines = await drain(res);
    const done = lines[lines.length - 1] as Record<string, unknown>;
    expect((done.matches as Record<string, unknown>[])[0].boundText).toBe("D-101");
  });

  // [DETECTOR closer] searchPages POSITIVE subset — the only prior searchPages case was the
  // zero-intersection 400. Pins that the filter actually narrows which pages get downloaded
  // (page keys) and the transcript's totalPages, not just the degenerate empty case.
  it("searchPages positive subset: only the requested existing pages are fetched; totalPages reflects the subset", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    await createPage(project.id, 2);
    await createPage(project.id, 3);
    asUser(user);
    h.templateMatch.mockImplementation(async (_opts: unknown, cbs?: { onProgress?: (p: unknown) => void }) => {
      cbs?.onProgress?.({ type: "progress", targetIndex: 0, targetPath: "t", matches: 0 });
      return { totalMatches: 0, results: [] };
    });
    const res = await call(body(project.id, { searchPages: [2, 3, 99] })); // 99 silently dropped (filtered vs EXISTING)
    expect(res.status).toBe(200);
    const lines = await drain(res);
    const progress = lines[0] as Record<string, unknown>;
    expect(progress.totalPages).toBe(2); // pages 2+3 only
    expect(progress.page).toBe(2); // pageMap[0] = first surviving page
    const fetchedKeys = h.downloadFromS3.mock.calls.map((c: unknown[]) => c[0]).sort();
    expect(fetchedKeys).toEqual([
      `${project.dataUrl}/original.pdf`,
      `${project.dataUrl}/pages/page_0002.png`,
      `${project.dataUrl}/pages/page_0003.png`,
    ]); // page_0001 NOT fetched; no page_0099
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

  // [DETECTOR closer] the Lambda branch's OWN OCR-bind try/catch (a deliberate duplicate of the
  // local block) was only frozen via the local path — pins FQ-5 key-absent on the Lambda side.
  it("lambda OCR-bind soft-fail: boundText key ABSENT, done still emitted (FQ-5, lambda branch)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.fanOutTemplateMatch.mockResolvedValue({
      results: [{ targetIndex: 0, bbox: [0.2, 0.2, 0.05, 0.05], confidence: 0.8, method: "template", scale: 1.0, pageS3Key: `${project.dataUrl}/pages/page_0001.png` }],
      failedPages: [],
      warnings: [],
    });
    h.bindOcrToShapes.mockImplementation(() => {
      throw new Error("ocr exploded");
    });
    const res = await call(body(project.id));
    expect(res.status).toBe(200);
    const lines = await drain(res);
    const done = lines[lines.length - 1] as Record<string, unknown>;
    expect(done.type).toBe("done");
    expect("boundText" in (done.matches as Record<string, unknown>[])[0]).toBe(false);
  });

  // [DETECTOR closer] multi-batch progress math was only frozen in the degenerate 1-batch shape.
  // Pins: cumulative matches, monotonic pagesDone (batchesDone COUNT × size, Math.min clamp),
  // ceil(totalBatches), and the OUT-OF-ORDER "Batch X/N" labels (expected, per the route note).
  it("lambda multi-batch: cumulative matches + monotonic pagesDone survive out-of-order batch completion (FQ-7b/8)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    await createPage(project.id, 2);
    await createPage(project.id, 3);
    asUser(user);
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.fanOutTemplateMatch.mockImplementation(
      async (opts: { onBatchComplete?: (idx: number, count: number) => void }) => {
        opts.onBatchComplete?.(2, 2); // batch 3 settles FIRST (out of order)
        opts.onBatchComplete?.(0, 1); // then batch 1
        return { results: [], failedPages: [], warnings: [] };
      },
    );
    const res = await call(body(project.id));
    const lines = await drain(res);
    // dispatch, batch progress ×2, done — TEMPLATE_MATCH_BATCH_SIZE mocked at its real default 1 → totalBatches = 3
    expect(lines).toHaveLength(4);
    expect(lines[1]).toEqual({
      type: "progress", page: 0, pageIndex: 1, totalPages: 3, matches: 2,
      message: "Batch 3/3 complete", // label jumps — batchIdx+1, NOT completion order
    });
    expect(lines[2]).toEqual({
      type: "progress", page: 0, pageIndex: 2, totalPages: 3, matches: 3, // cumulative 2+1; pagesDone monotonic
      message: "Batch 1/3 complete",
    });
    expect((lines[3] as Record<string, unknown>).type).toBe("done");
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

  // [S024 fold: E] WHOLE assertion set flipped: legacy's unguarded `await req.json()` +
  // destructure (old route.ts:27-28, outside any try) rejected raw on malformed/empty/null
  // (frozen at 0b91a74 as .rejects.toThrow(); raw framework 500 in prod). Now the shell's
  // enveloped 400s: malformed → BAD_REQUEST "Invalid JSON body"; empty/null → zLooseBody
  // VALIDATION (zod wording, code pinned only).
  it("malformed / empty / null bodies → enveloped 400s (diff E; legacy rejected raw)", async () => {
    signedOut(); // fires at the shell body parse, before auth could matter
    const raw = (payload: string) =>
      POST(
        new Request("http://test.local/api/symbol-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      );
    const malformed = await readJson(await raw("{not json"));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toEqual({ code: "BAD_REQUEST", message: "Invalid JSON body" });
    for (const payload of ["", "null"]) {
      const { status, body: resBody } = await readJson(await raw(payload));
      expect(status).toBe(400);
      expect(resBody.error.code).toBe("VALIDATION"); // zLooseBody message not pinned (zod wording)
    }
  });

  it("number / array bodies → VALIDATION 400 (diff E; legacy 'Missing…' 400 — status preserved, message drifts)", async () => {
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
      expect(status).toBe(400); // [S024 fold: E] flipped — was legacy's field-cascade 400; the S013 cosmetic class
      expect(resBody.error.code).toBe("VALIDATION");
    }
  });

  // [S024 fold: B] WHOLE assertion flipped: a non-castable string projectId reached the pg
  // integer cast (old route.ts:64, outside the try) → raw rejection (frozen at 0b91a74 as
  // .rejects.toThrow()). Now the shell catches the uncaught pg throw → generic INTERNAL 500,
  // never leaking the pg message.
  it("non-castable string projectId → 500 generic INTERNAL (diff B; legacy rejected raw)", async () => {
    signedOut();
    const { status, body: resBody } = await readJson(await call(body("abc")));
    expect(status).toBe(500);
    expect(resBody).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  // ── validate-before-auth composite pin ─────────────────────────────────────────────────────

  it("field-400 beats access-404: incomplete body + unknown project + signed-out → 400 'Missing…'", async () => {
    signedOut();
    const { status, body: resBody } = await readJson(
      await call({ projectId: 999999999, sourcePageNumber: 1 }), // no templateBbox
    );
    expect(status).toBe(400); // NOT the engine's 404
    expect(resBody).toEqual({
      error: { code: "VALIDATION", message: "Missing projectId, sourcePageNumber, or templateBbox" },
    }); // [S024 fold: A] flipped
  });
});
