// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/projects/[id]/export, written as THE FREEZE
// before the P1.5 migration onto services/export.ts (exportProject). ⚠️ This bundle is the ingest
// contract for EXTERNAL headless / gaussian-fingerprint tooling (no first-party consumer) — the
// 200 body must stay BYTE-IDENTICAL across the fold. Frozen:
//   • access = resolveProjectAccess({publicId}, {allowDemo:true}) FIRST (no earlier validation):
//     demo exportable signed-out; unknown → 404 BEFORE auth; non-demo signed-out → 401;
//     cross-tenant → 404; root bypass → 200.
//   • bundle shape: schemaVersion "bp-export/1"; exportedAt = fresh ISO timestamp (assert type,
//     not value); project block {publicId,name,dataUrl,numPages,status,projectIntelligence,
//     projectSummary} with ??null on the two heavies; models = company-scoped {name,type,config};
//     assets {pdfKey, pdfUrl}; pages ordered by pageNumber with textractData/pageIntelligence
//     present by default; annotations mapped to the 8-field {id,name,bbox[minX,minY,maxX,maxY],
//     pageNumber,threshold,source,data,note}.
//   • ?omit=textract / intelligence → the field is set to UNDEFINED → JSON.stringify DROPS the
//     key entirely (pinned by key-set assertions). ?omit=images → pdfUrl null + page.image null
//     and NO presign calls.
//   • ?pages= filter quirks: "2-3" range, "1,3" list, lo/hi SWAP tolerance ("3-1" === "1-3"),
//     junk parts silently dropped; junk-only → null filter → ALL pages.
//   • presign failure → safePresign catch → null URL, still 200 (per-key, non-fatal).
//   • PADDED page_NNNN.png keys (the engine convention).
//   • non-uuid id: legacy = pg uuid-cast throw inside resolveProjectAccess (raw 500, S003
//     class) → flips to a clean 400 at fold time (sanctioned diff C).
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({
  downloadFromS3: vi.fn(),
  uploadToS3: vi.fn(),
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  getPresignedGetUrl: vi.fn(),
}));
vi.mock("@/lib/s3", () => s3Mocks);

import { GET } from "@/app/api/projects/[id]/export/route";
import { db } from "@/lib/db";
import { annotations, models } from "@/lib/db/schema";
import {
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  params,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const exp = (id: string, qs = "") =>
  GET(makeReq(`/api/projects/${id}/export${qs}`, { method: "GET" }), params({ id }));

describe.skipIf(!dbUp)("GET /api/projects/[id]/export", () => {
  it("happy: full bundle — schemaVersion, project block, models, padded presigns, pages, annotations", async () => {
    const { user, project, company } = await createWorld();
    await createPage(project.id, 1, {
      textractData: { blocks: [1] } as never,
      pageIntelligence: { summary: "s" } as never,
      drawingNumber: "A-1",
    });
    await createPage(project.id, 2);
    await db.insert(models).values({
      companyId: company.id,
      name: "yolo-v1",
      type: "yolo",
      s3Path: "s3://m/yolo-v1",
      config: { classes: ["door"] } as never,
    });
    // [DETECTOR closer SD-2] one real annotation so the 8-field map + bbox ORDER are value-pinned
    // (the bundle is an external contract; [] alone would let a field drop/rename ship).
    const [ann] = await db
      .insert(annotations)
      .values({
        name: "det-1",
        minX: 0.1,
        minY: 0.2,
        maxX: 0.3,
        maxY: 0.4,
        pageNumber: 1,
        projectId: project.id,
        threshold: 0.5,
        source: "yolo",
        data: { modelName: "yolo-v1" } as never,
        note: "n1",
      })
      .returning();
    asUser(user);
    s3Mocks.getPresignedGetUrl.mockImplementation(async (key: string) => `https://signed.test/${key}`);

    const { status, body } = await readJson(await exp(project.publicId));
    expect(status).toBe(200);
    expect(body.schemaVersion).toBe("bp-export/1");
    expect(typeof body.exportedAt).toBe("string");
    expect(new Date(body.exportedAt).toString()).not.toBe("Invalid Date");
    expect(body.project).toEqual({
      publicId: project.publicId,
      name: project.name,
      dataUrl: project.dataUrl,
      numPages: project.numPages,
      status: project.status,
      projectIntelligence: null, // ?? null on the heavies
      projectSummary: null,
    });
    expect(body.models).toEqual([{ name: "yolo-v1", type: "yolo", config: { classes: ["door"] } }]);
    expect(body.assets).toEqual({
      pdfKey: `${project.dataUrl}/original.pdf`,
      pdfUrl: `https://signed.test/${project.dataUrl}/original.pdf`,
    });
    // [DETECTOR closer SD-3] exact root key set — an ADDED stray bundle key would ship unnoticed
    expect(Object.keys(body).sort()).toEqual([
      "annotations",
      "assets",
      "exportedAt",
      "models",
      "pages",
      "project",
      "schemaVersion",
    ]);
    expect(body.pages).toHaveLength(2);
    expect(body.pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([1, 2]); // orderBy
    // [DETECTOR closer SD-3] FULL page-object toEqual — pins all 11 fields incl. the previously
    // unasserted name/drawingNumber/rawText/csiCodes/keynotes/textAnnotations/error, and the
    // page key set itself (external bp-export/1 contract).
    expect(body.pages[0]).toEqual({
      pageNumber: 1,
      name: "Page 1",
      drawingNumber: "A-1",
      rawText: null,
      csiCodes: null,
      keynotes: null,
      textAnnotations: null,
      textractData: { blocks: [1] }, // present by default
      pageIntelligence: { summary: "s" },
      error: null,
      image: {
        // PADDED keys (page_0001, the engine convention)
        pngKey: `${project.dataUrl}/pages/page_0001.png`,
        pngUrl: `https://signed.test/${project.dataUrl}/pages/page_0001.png`,
        thumbKey: `${project.dataUrl}/thumbnails/page_0001.png`,
        thumbUrl: `https://signed.test/${project.dataUrl}/thumbnails/page_0001.png`,
      },
    });
    // [DETECTOR closer SD-2] the full 8-field annotation map, bbox ORDER pinned by value
    expect(body.annotations).toEqual([
      {
        id: ann.id,
        name: "det-1",
        bbox: [0.1, 0.2, 0.3, 0.4], // [minX, minY, maxX, maxY]
        pageNumber: 1,
        threshold: 0.5,
        source: "yolo",
        data: { modelName: "yolo-v1" },
        note: "n1",
      },
    ]);
  });

  it("?omit=textract,intelligence DROPS the keys (undefined → absent); ?omit=images nulls urls + skips presigns", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {
      textractData: { blocks: [1] } as never,
      pageIntelligence: { summary: "s" } as never,
    });
    asUser(user);
    s3Mocks.getPresignedGetUrl.mockImplementation(async (key: string) => `https://signed.test/${key}`);

    const omitted = await readJson(await exp(project.publicId, "?omit=textract,intelligence"));
    expect(omitted.status).toBe(200);
    const keys = Object.keys(omitted.body.pages[0]);
    expect(keys).not.toContain("textractData"); // undefined-dropped, not null
    expect(keys).not.toContain("pageIntelligence");

    s3Mocks.getPresignedGetUrl.mockClear();
    const noImg = await readJson(await exp(project.publicId, "?omit=images"));
    expect(noImg.status).toBe(200);
    expect(noImg.body.assets.pdfUrl).toBeNull();
    expect(noImg.body.pages[0].image).toBeNull();
    expect(s3Mocks.getPresignedGetUrl).not.toHaveBeenCalled(); // presigning skipped entirely
  });

  it("?pages= filter: range, list, lo/hi swap tolerance; junk-only → no filter (all pages)", async () => {
    const { user, project } = await createWorld();
    for (const n of [1, 2, 3]) await createPage(project.id, n);
    asUser(user);
    s3Mocks.getPresignedGetUrl.mockResolvedValue("https://signed.test/k");

    const nums = async (qs: string) =>
      (await readJson(await exp(project.publicId, qs))).body.pages.map(
        (p: { pageNumber: number }) => p.pageNumber,
      );
    expect(await nums("?pages=2-3")).toEqual([2, 3]);
    expect(await nums("?pages=1,3")).toEqual([1, 3]);
    expect(await nums("?pages=3-1")).toEqual([1, 2, 3]); // lo/hi swap → full range
    expect(await nums("?pages=zzz")).toEqual([1, 2, 3]); // junk-only → null filter → all
  });

  it("presign failure → null url per key, still 200 (safePresign catch)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    s3Mocks.getPresignedGetUrl.mockRejectedValue(new Error("s3 down"));
    const { status, body } = await readJson(await exp(project.publicId));
    expect(status).toBe(200);
    expect(body.assets.pdfUrl).toBeNull();
    expect(body.pages[0].image.pngUrl).toBeNull(); // keys still present, urls null
    expect(body.pages[0].image.pngKey).toBe(`${project.dataUrl}/pages/page_0001.png`);
  });

  it("B2 RED access matrix: export is authenticated project tooling only; no anonymous demo projection", async () => {
    s3Mocks.getPresignedGetUrl.mockResolvedValue("https://signed.test/k");

    const demo = await createWorld({
      projectSummary: "PRIVATE-EXPORT-SUMMARY-CANARY",
      projectIntelligence: { privateCanary: "PRIVATE-EXPORT-PI-CANARY" } as any,
    });
    await createPage(demo.project.id, 1, {
      rawText: "PRIVATE-EXPORT-OCR-CANARY",
      textractData: { privateCanary: "PRIVATE-EXPORT-TEXTRACT-CANARY" } as never,
    });
    await db.insert(annotations).values({
      projectId: demo.project.id,
      pageNumber: 1,
      name: "PRIVATE-EXPORT-ANNOTATION-CANARY",
      note: "PRIVATE-EXPORT-NOTE-CANARY",
      minX: 0.1,
      minY: 0.1,
      maxX: 0.2,
      maxY: 0.2,
      source: "user",
    });
    await publishDemoFixture(demo.project.id);
    signedOut();
    const demoResponse = await readJson(await exp(demo.project.publicId));
    expect.soft(demoResponse.status).toBe(401);
    expect.soft(demoResponse.body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
    const anonymousBody = JSON.stringify(demoResponse.body);
    for (const forbidden of [
      "dataUrl",
      demo.project.dataUrl,
      "PRIVATE-EXPORT-SUMMARY-CANARY",
      "PRIVATE-EXPORT-PI-CANARY",
      "PRIVATE-EXPORT-OCR-CANARY",
      "PRIVATE-EXPORT-TEXTRACT-CANARY",
      "PRIVATE-EXPORT-ANNOTATION-CANARY",
      "PRIVATE-EXPORT-NOTE-CANARY",
    ]) {
      expect.soft(anonymousBody).not.toContain(forbidden);
    }
    asUser(demo.user);
    expect.soft((await readJson(await exp(demo.project.publicId))).status).toBe(200);

    const world = await createWorld();
    signedOut();
    const noAuth = await readJson(await exp(world.project.publicId));
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" }); // [P1.5 fold] flipped

    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await exp(world.project.publicId));
    expect(cross.status).toBe(404);
    expect(cross.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    expect((await readJson(await exp(world.project.publicId))).status).toBe(200); // root bypass

    signedOut();
    const unknown = await readJson(await exp(randomUUID()));
    expect(unknown.status).toBe(401); // authentication precedes project lookup
    expect(unknown.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  // [DETECTOR closer SD-4] sanctioned diff B representative: an UNEXPECTED throw (here the first
  // db.select, inside the access engine) → the shell's generic INTERNAL 500, message NOT leaked.
  it("unexpected db throw → 500 generic INTERNAL, no message leak (diff B)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("secret-db-detail");
    });
    const { status, body } = await readJson(await exp(project.publicId));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("secret-db-detail");
  });

  it("B2 RED: export authenticates before id validation; authenticated non-uuid remains a clean 400", async () => {
    signedOut();
    const anonymous = await readJson(await exp("not-a-uuid"));
    expect.soft(anonymous.status).toBe(401);
    expect.soft(anonymous.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" });

    const { user } = await createWorld();
    asUser(user);
    const authenticated = await readJson(await exp("not-a-uuid"));
    expect.soft(authenticated.status).toBe(400);
    expect.soft(authenticated.body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });
});
