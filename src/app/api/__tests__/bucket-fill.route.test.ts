// @vitest-environment node
// [refactor jul6 S030] CHARACTERIZATION for POST /api/bucket-fill, written as THE FREEZE
// before the P1.5 fold onto services/bucket-fill.ts — THE LAST PARSE-FAMILY ROUTE. OpenCV
// flood-fill server FALLBACK (the worker does the real work client-side; this fires only on
// worker failure — AnnotationOverlay.tsx serverFallback is the sole fetch consumer). Engine
// @/lib/bucket-fill mocked at the module seam; REAL DB via harness. Frozen:
//   • BQ-1 cascade: truthy "Missing projectId, pageNumber, or seedPoint" (falsy-zero) →
//     "Invalid seedPoint (must be normalized 0-1)" (typeof x/y number, 0..1 INCLUSIVE —
//     boundary 0 and 1 are VALID) → resolveProjectAccess({dbId},{allowDemo:true}) →
//     project.isDemo gate "bucketFill" flat 403 (DEFAULT_ON=true) → !dataUrl 404 "Project
//     not found" (S024 WAIVER class — untestable, structural only). req.json() pre-try →
//     malformed/empty/null + non-castable dbId REJECT RAW at legacy.
//   • BQ-2 boundary clamps (pinned via engine-arg asserts): leakThreshold →
//     [0.05, 0.95]; tolerance → max(0, ·) (negative → 0 for the python path). Defaults:
//     tolerance 30, dilate 3, simplifyEpsilon 0.005, leakThreshold 0.25, barriers [],
//     polygonBarriers []. Unknown body fields (client sends textBboxes) are IGNORED.
//   • BQ-3 padded page_NNNN.png happy path; PNG-miss → original.pdf + rasterizePage(pdf,
//     n, 200) fallback; both-fail → CONTROLLED "Failed to load page image" 500 — message
//     KEPT at fold as ApiError INTERNAL (surfaces via defineRoute:254; SAME string as
//     shape-parse's pin — shared message).
//   • BQ-4 engine passthrough: bucketFill({imagePath: <tempDir>/page_NNNN.png, pageNumber,
//     seedX, seedY, tolerance: clamped, dilatePx: dilate, simplifyEpsilon, leakThreshold:
//     clamped, barriers, polygonBarriers}); the RESULT — including the engine's in-band
//     {type:"error"} AT HTTP 200 — returns verbatim (success-path body, NEVER enveloped;
//     AnnotationOverlay reads data.type/.vertices/.error in-band).
//   • BQ-5 the catch-all returns the FIXED literal "Bucket fill failed" 500 (no leak) —
//     retired at fold → shell generic INTERNAL 500 (S015 "Promote failed" precedent).
//   • BQ-6 tempDir: mkdtemp pre-try; finally rm(...).catch(()=>{}) SWALLOWED (unlike
//     table-structure's awaited rm — transplant keeps the swallow verbatim).
// Assertions tagged [S030 fold] flip in the fold commit (sanctioned A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  bucketFill: vi.fn(),
  downloadFromS3: vi.fn(),
  rasterizePage: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("@/lib/bucket-fill", () => ({ bucketFill: h.bucketFill }));
vi.mock("@/lib/s3", () => ({
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  downloadFromS3: h.downloadFromS3,
  uploadToS3: vi.fn(),
  deleteProjectFiles: vi.fn(),
}));
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: h.rasterizePage }));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  writeFile: h.writeFile,
  rm: h.rm,
}));

import { POST } from "@/app/api/bucket-fill/route";
import {
  asUser,
  createCompany,
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

const RESULT = { type: "result", vertices: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }], holes: [], method: "raster" };

const call = (b: unknown) => POST(makeReq("/api/bucket-fill", { body: b }));
const bodyFor = (projectId: unknown, over: Record<string, unknown> = {}) => ({
  projectId,
  pageNumber: 2,
  seedPoint: { x: 0.5, y: 0.5 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.bucketFill.mockResolvedValue({ ...RESULT });
  h.downloadFromS3.mockResolvedValue(Buffer.from("png"));
  h.rasterizePage.mockResolvedValue(Buffer.from("rasterized"));
  h.writeFile.mockResolvedValue(undefined);
  h.rm.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("POST /api/bucket-fill — cascade (BQ-1)", () => {
  it("truthy field 400 (falsy-zero) then seedPoint validation; 0/1 boundaries VALID", async () => {
    for (const b of [bodyFor(0), { projectId: 1, seedPoint: { x: 0.5, y: 0.5 } }, bodyFor(1, { seedPoint: undefined })]) {
      const { status, body } = await readJson(await call(b));
      expect(status).toBe(400);
      // [S030 fold: A applied — was flat]
      expect(body).toEqual({ error: { code: "VALIDATION", message: "Missing projectId, pageNumber, or seedPoint" } });
    }
    for (const sp of [{ x: "0.5", y: 0.5 }, { x: -0.1, y: 0.5 }, { x: 0.5, y: 1.5 }, {}]) {
      const { status, body } = await readJson(await call(bodyFor(1, { seedPoint: sp })));
      expect(status).toBe(400);
      expect(body).toEqual({ error: { code: "VALIDATION", message: "Invalid seedPoint (must be normalized 0-1)" } }); // [S030 fold: A applied]
    }
    // boundary values are valid → proceeds to access (signed-out non-demo → 401)
    const { user, project } = await createWorld();
    void user;
    const r = await readJson(await call(bodyFor(project.id, { seedPoint: { x: 0, y: 1 } })));
    expect(r.status).toBe(401);
  });

  it("malformed / empty / 'null' bodies + non-castable dbId: raw rejections (pre-try)", async () => {
    // [S030 fold: E — malformed→BAD_REQUEST 400, empty/null→VALIDATION 400; B — pg-cast→generic 500]
    const mk = (raw: string | undefined) =>
      new Request("http://test.local/api/bucket-fill", {
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
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S030 fold: E+B applied]
  });

  it("access 401/404/neg-404 + demo gate 'bucketFill' flat 403 / default-on 200", async () => {
    const { project } = await createWorld();
    let r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S030 fold: A applied]
    const other = await createCompany();
    asUser(await createUser(other.id));
    r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S030 fold: A applied]
    r = await readJson(await call(bodyFor(-5)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // int-guard DECLINED [S030 fold: A applied]
    signedOut();
    const demo = await createWorld({ isDemo: true });
    await db.update(companies).set({ pipelineConfig: { demo: { bucketFill: false } } }).where(eq(companies.id, demo.company.id));
    r = await readJson(await call(bodyFor(demo.project.id)));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Bucket Fill is disabled for demo users. Sign in to use this feature." }); // flat, never flips
    await db.update(companies).set({ pipelineConfig: {} }).where(eq(companies.id, demo.company.id));
    r = await readJson(await call(bodyFor(demo.project.id)));
    expect(r.status).toBe(200); // DEFAULT_ON.bucketFill; anon demo read via allowDemo
  });
});

describe.skipIf(!dbUp)("pipeline (BQ-2/3/4/5/6)", () => {
  it("happy: padded key, defaults + engine-arg contract, result passthrough verbatim", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200);
    expect(body).toEqual(RESULT); // verbatim passthrough
    const key = h.downloadFromS3.mock.calls[0][0] as string;
    expect(key.endsWith("/pages/page_0002.png")).toBe(true);
    expect(h.writeFile).toHaveBeenCalledTimes(1);
    const engineArgs = h.bucketFill.mock.calls[0][0];
    expect(engineArgs).toMatchObject({
      pageNumber: 2, seedX: 0.5, seedY: 0.5,
      tolerance: 30, dilatePx: 3, simplifyEpsilon: 0.005, leakThreshold: 0.25,
      barriers: [], polygonBarriers: [],
    });
    expect(engineArgs.imagePath.endsWith("page_0002.png")).toBe(true);
    expect(h.rm).toHaveBeenCalledTimes(1); // finally (swallowed) still fires
  });

  it("BQ-2 clamps: tolerance -5→0; leakThreshold 100→0.95 and 0.001→0.05; passthrough options", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await call(bodyFor(project.id, { tolerance: -5, leakThreshold: 100, dilate: 7, simplifyEpsilon: 0.01, barriers: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] }));
    expect(h.bucketFill.mock.calls[0][0]).toMatchObject({
      tolerance: 0, leakThreshold: 0.95, dilatePx: 7, simplifyEpsilon: 0.01,
      barriers: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
    });
    await call(bodyFor(project.id, { leakThreshold: 0.001 }));
    expect(h.bucketFill.mock.calls[1][0].leakThreshold).toBe(0.05);
  });

  it("BQ-4 in-band engine error at HTTP 200 passes through verbatim (never enveloped)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    h.bucketFill.mockResolvedValue({ type: "error", error: "seed point on a wall" });
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(200);
    expect(body).toEqual({ type: "error", error: "seed point on a wall" });
  });

  it("BQ-3 PNG-miss → pdf+rasterize(n,200); both-fail → CONTROLLED 500 'Failed to load page image'", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    h.downloadFromS3.mockImplementation(async (key: string) => {
      if (key.endsWith(".png")) throw new Error("no png");
      return Buffer.from("pdf");
    });
    let r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(200);
    expect(h.rasterizePage).toHaveBeenCalledWith(Buffer.from("pdf"), 2, 200);
    h.downloadFromS3.mockRejectedValue(new Error("s3 dead"));
    r = await readJson(await call(bodyFor(project.id)));
    expect(r.status).toBe(500);
    // [S030 fold: A applied — message KEPT] ApiError INTERNAL surfaces (S024 pin class; shared w/ shape-parse)
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Failed to load page image" } });
  });

  it("BQ-5 engine throw → the FIXED 'Bucket fill failed' 500 (no leak); rm still fires", async () => {
    // [S030 fold: B — retired → shell generic INTERNAL 500 (S015 "Promote failed" precedent)]
    const { user, project } = await createWorld();
    asUser(user);
    h.bucketFill.mockRejectedValue(new Error("cv exploded — should NOT appear"));
    const { status, body } = await readJson(await call(bodyFor(project.id)));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S030 fold: B applied — fixed literal retired, S015 precedent]
    expect(h.rm).toHaveBeenCalledTimes(1); // finally (swallowed) KEPT
  });
});

// [hardening sep30] `dilate` becomes an n-by-n allocation in the Python script.
describe.skipIf(!dbUp)("input bounds", () => {
  it("dilate is clamped to an integer 0..25; non-numbers fall back to the default", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await call(bodyFor(project.id, { dilate: 40_000 }));
    expect(h.bucketFill.mock.calls[0][0].dilatePx).toBe(25);
    await call(bodyFor(project.id, { dilate: -4 }));
    expect(h.bucketFill.mock.calls[1][0].dilatePx).toBe(0);
    await call(bodyFor(project.id, { dilate: "9999" }));
    expect(h.bucketFill.mock.calls[2][0].dilatePx).toBe(3);
  });

  it("more than 500 barriers → 400 VALIDATION before the engine runs", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const barriers = Array.from({ length: 501 }, () => ({ x1: 0, y1: 0, x2: 1, y2: 1 }));
    const { status, body } = await readJson(await call(bodyFor(project.id, { barriers })));
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: "VALIDATION", message: "Too many barriers (max 500)" } });
    expect(h.bucketFill).not.toHaveBeenCalled();
  });
});

// [hardening sep30] The script computes `int(v["x"] * w)`: a string there is REPEATED w times.
describe("coordinate and page validation (before any lookup)", () => {
  const invalidBarriers = {
    error: { code: "VALIDATION", message: "Invalid barriers (coordinates must be numbers)" },
  };

  it("a string or non-finite coordinate anywhere in a barrier is refused", async () => {
    for (const over of [
      { polygonBarriers: [{ vertices: [{ x: "A".repeat(1_000), y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }] }] },
      { polygonBarriers: [{ vertices: "nope" }] },
      { polygonBarriers: [null] },
      { barriers: [{ x1: "0", y1: 0, x2: 1, y2: 1 }] },
      { barriers: [{ x1: 0, y1: 0, x2: 1e9, y2: 1 }] },
      { barriers: [{ x1: 0, y1: 0, x2: 1 }] },
    ]) {
      const { status, body } = await readJson(await call(bodyFor(1, over)));
      expect(status).toBe(400);
      expect(body).toEqual(invalidBarriers);
    }
    expect(h.bucketFill).not.toHaveBeenCalled();
  });

  it("a polygon with more than 2,000 vertices is refused", async () => {
    const vertices = Array.from({ length: 2_001 }, () => ({ x: 0.5, y: 0.5 }));
    const { status, body } = await readJson(await call(bodyFor(1, { polygonBarriers: [{ vertices }] })));
    expect(status).toBe(400);
    expect(body).toEqual(invalidBarriers);
  });

  it("a barrier dragged slightly past the page edge is still accepted as a coordinate", async () => {
    signedOut();
    const { status, body } = await readJson(
      await call(bodyFor(2_000_000_000, { barriers: [{ x1: -0.01, y1: 0, x2: 1.02, y2: 1 }] })),
    );
    // Passed validation: the refusal comes from the project lookup, not the coordinate check.
    expect(status).not.toBe(400);
    expect(body.error?.message).not.toMatch(/barriers/);
  });

  it("pageNumber must be a positive integer — it becomes an S3 key and a Ghostscript argument", async () => {
    for (const pageNumber of [1.5, -1, "1/../../x", 1e9, [1]]) {
      const { status, body } = await readJson(await call(bodyFor(1, { pageNumber })));
      expect(status).toBe(400);
      expect(body).toEqual({ error: { code: "VALIDATION", message: "Invalid pageNumber" } });
    }
  });
});
