// @vitest-environment node
// [fix 2026-10-21 reprocess-persistence] Viewer shape parse PERSISTS (DB-backed).
// Owner 2026-10-21: viewer shape parse "doesnt always appear to save" — it never saved: the
// service only read, and the hook only wrote the React Query cache, so a reload lost every
// run. Now each page that was actually scanned is swapped into pages.keynotes + source=
// 'shape-parse' annotations (shape-parse-persist.ts). Same mock seams as the SQ freeze file.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

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
  sharp: vi.fn(),
}));

vi.mock("@/lib/keynotes", () => ({ extractKeynotes: h.extractKeynotes }));
vi.mock("@/lib/ocr-shape-binding", () => ({ bindOcrToShapes: h.bindOcrToShapes }));
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
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: vi.fn() }));
vi.mock("sharp", () => ({ default: h.sharp }));

import { POST } from "@/app/api/shape-parse/route";
import { asUser, annotationsFor, createPage, createWorld, makeReq, publishDemoFixture, readJson, signedOut } from "@/test/harness";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;
const call = (b: unknown) => POST(makeReq("/api/shape-parse", { body: b })).then(readJson);

const OUTSIDE = { shape: "circle", text: "OUT", bbox: [0.1, 0.1, 0.2, 0.2], contour: [] };
const INSIDE_OLD = { shape: "circle", text: "IN-OLD", bbox: [0.5, 0.5, 0.6, 0.6], contour: [] };
const FOUND = { shape: "hexagon", text: "NEW", bbox: [0.5, 0.5, 0.6, 0.6], contour: [[0.5, 0.5]] };

async function seedPage(projectId: number, pageNumber: number, keynotes: typeof OUTSIDE[]) {
  await createPage(projectId, pageNumber, { keynotes: keynotes as never });
  for (const k of keynotes) {
    await db.insert(annotations).values({
      name: k.shape, minX: k.bbox[0], minY: k.bbox[1], maxX: k.bbox[2], maxY: k.bbox[3],
      pageNumber, threshold: 0.9, source: "shape-parse", projectId,
      data: { modelName: "shape-parse", shapeType: k.shape, text: k.text } as never,
    });
  }
}

async function stored(projectId: number, pageNumber: number) {
  const [row] = await db.select({ keynotes: pages.keynotes }).from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)));
  const anns = (await annotationsFor(projectId)).filter((a) => a.source === "shape-parse" && a.pageNumber === pageNumber);
  return { keynotes: row?.keynotes ?? null, texts: anns.map((a) => (a.data as { text?: string }).text).sort() };
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.extractKeynotes.mockResolvedValue({ keynotes: [FOUND], warnings: [] });
  h.bindOcrToShapes.mockImplementation((shapes: unknown[]) => shapes.map(() => ({ boundText: null })));
  h.isLambdaCvEnabled.mockReturnValue(false);
  h.downloadFromS3.mockResolvedValue(Buffer.from("png"));
  h.sharp.mockImplementation(() => ({
    metadata: async () => ({ width: 1000, height: 1000 }),
    extract: () => ({ png: () => ({ toBuffer: async () => Buffer.from("cropped") }) }),
  }));
});

describe.skipIf(!dbUp)("viewer shape parse persists", () => {
  it("single page: the page's shapes are REPLACED in both stores, and the response says what was stored", async () => {
    const { user, project } = await createWorld();
    await seedPage(project.id, 1, [OUTSIDE, INSIDE_OLD]);
    asUser(user);

    const { status, body } = await call({ projectId: project.id, pageNumber: 1 });

    expect(status).toBe(200);
    expect(await stored(project.id, 1)).toEqual({ keynotes: [FOUND], texts: ["NEW"] });
    expect(body.persisted.pages).toEqual({ 1: [FOUND] });
    expect(body.persisted.annotations).toHaveLength(1);
    expect(body.persisted.annotations[0]).toMatchObject({ pageNumber: 1, source: "shape-parse", bbox: FOUND.bbox });
    expect(body.persisted.removedAnnotationIds).toHaveLength(2);
    // a repeat run does not double the page (the old client APPENDED to its cache)
    await call({ projectId: project.id, pageNumber: 1 });
    expect(await stored(project.id, 1)).toEqual({ keynotes: [FOUND], texts: ["NEW"] });
  });

  it("region run replaces only the shapes whose centre is inside the region", async () => {
    const { user, project } = await createWorld();
    await seedPage(project.id, 1, [OUTSIDE, INSIDE_OLD]);
    asUser(user);
    // crop-relative hit [0.25..0.5] inside region [0.4,0.4,0.8,0.8] → page [0.5..0.6]
    h.extractKeynotes.mockResolvedValue({
      keynotes: [{ shape: "hexagon", text: "NEW", bbox: [0.25, 0.25, 0.5, 0.5], contour: [] }],
      warnings: [],
    });

    const { body } = await call({ projectId: project.id, pageNumber: 1, regionBbox: [0.4, 0.4, 0.8, 0.8] });

    const after = await stored(project.id, 1);
    expect(after.texts).toEqual(["NEW", "OUT"]); // OUT kept, IN-OLD replaced
    expect((after.keynotes as { text: string }[]).map((k) => k.text)).toEqual(["OUT", "NEW"]);
    expect(body.persisted.removedAnnotationIds).toHaveLength(1);
    expect(body.persisted.pages[1].map((k: { text: string }) => k.text)).toEqual(["OUT", "NEW"]);
  });

  it("a FAILED scan writes nothing — the page's previous shapes survive", async () => {
    const { user, project } = await createWorld();
    await seedPage(project.id, 1, [OUTSIDE]);
    asUser(user);
    h.extractKeynotes.mockResolvedValue({ keynotes: [], warnings: ["Extraction failed: python died"], failed: true });

    const { status, body } = await call({ projectId: project.id, pageNumber: 1 });

    expect(status).toBe(200);
    expect("persisted" in body).toBe(false);
    expect(await stored(project.id, 1)).toEqual({ keynotes: [OUTSIDE], texts: ["OUT"] });
  });

  it("scanAll (Lambda): only pages the fan-out CONFIRMED are written; a failed page keeps its rows", async () => {
    const { user, project } = await createWorld();
    await seedPage(project.id, 1, [OUTSIDE]);
    await seedPage(project.id, 2, [OUTSIDE]);
    await seedPage(project.id, 3, [OUTSIDE]);
    asUser(user);
    const key = (n: number) => `${project.dataUrl}/pages/page_000${n}.png`;
    h.isLambdaCvEnabled.mockReturnValue(true);
    h.fanOutShapeParse.mockResolvedValue({
      results: [{ ...FOUND, pageS3Key: key(1) }],
      okPages: [key(1), key(3)], // page 3 scanned, no shapes
      failedPages: [key(2)],
      pageErrors: { [key(2)]: "Lambda error: Task timed out after 120.00 seconds" },
      warnings: [],
    });

    const { body } = await call({ projectId: project.id, scanAll: true });

    expect(await stored(project.id, 1)).toEqual({ keynotes: [FOUND], texts: ["NEW"] });
    expect(await stored(project.id, 2)).toEqual({ keynotes: [OUTSIDE], texts: ["OUT"] });
    expect(await stored(project.id, 3)).toEqual({ keynotes: null, texts: [] });
    expect(Object.keys(body.persisted.pages).sort()).toEqual(["1", "3"]);
    expect(body.failedPages).toEqual([key(2)]);
  });

  it("scanAll (local): a page whose extraction failed is not written", async () => {
    const { user, project } = await createWorld();
    await seedPage(project.id, 1, [OUTSIDE]);
    await seedPage(project.id, 2, [OUTSIDE]);
    asUser(user);
    h.extractKeynotes
      .mockResolvedValueOnce({ keynotes: [FOUND], warnings: [] })
      .mockResolvedValueOnce({ keynotes: [], warnings: ["Extraction failed: timeout"], failed: true });

    await call({ projectId: project.id, scanAll: true });

    expect(await stored(project.id, 1)).toEqual({ keynotes: [FOUND], texts: ["NEW"] });
    expect(await stored(project.id, 2)).toEqual({ keynotes: [OUTSIDE], texts: ["OUT"] });
  });

  it("demo projects stay compute-only (demo never writes), even for an anonymous caller", async () => {
    const { project } = await createWorld();
    await seedPage(project.id, 1, [OUTSIDE]); // child rows first, then publish (demo rows are write-guarded)
    await publishDemoFixture(project.id);

    const { status, body } = await call({ projectId: project.id, pageNumber: 1 });

    expect(status).toBe(200);
    expect(body.keynotes).toHaveLength(1);
    expect("persisted" in body).toBe(false);
    expect(await stored(project.id, 1)).toEqual({ keynotes: [OUTSIDE], texts: ["OUT"] });
  });
});
