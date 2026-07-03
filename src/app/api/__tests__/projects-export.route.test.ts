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
import { models } from "@/lib/db/schema";
import {
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  params,
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
    expect(body.pages).toHaveLength(2);
    expect(body.pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([1, 2]); // orderBy
    const p1 = body.pages[0];
    expect(p1.textractData).toEqual({ blocks: [1] }); // present by default
    expect(p1.pageIntelligence).toEqual({ summary: "s" });
    // PADDED keys (page_0001, the engine convention)
    expect(p1.image).toEqual({
      pngKey: `${project.dataUrl}/pages/page_0001.png`,
      pngUrl: `https://signed.test/${project.dataUrl}/pages/page_0001.png`,
      thumbKey: `${project.dataUrl}/thumbnails/page_0001.png`,
      thumbUrl: `https://signed.test/${project.dataUrl}/thumbnails/page_0001.png`,
    });
    expect(body.annotations).toEqual([]);
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

  it("access matrix: demo signed-out 200 (allowDemo); non-demo signed-out 401; cross-tenant 404; root 200; unknown 404-before-auth", async () => {
    s3Mocks.getPresignedGetUrl.mockResolvedValue("https://signed.test/k");

    const demo = await createWorld({ isDemo: true });
    signedOut();
    expect((await readJson(await exp(demo.project.publicId))).status).toBe(200); // demo = public export

    const world = await createWorld();
    signedOut();
    const noAuth = await readJson(await exp(world.project.publicId));
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error).toBe("Unauthorized"); // [P1.5 fold] → {code:"UNAUTHORIZED",message:"Unauthorized"}

    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await exp(world.project.publicId));
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    expect((await readJson(await exp(world.project.publicId))).status).toBe(200); // root bypass

    signedOut();
    const unknown = await readJson(await exp(randomUUID()));
    expect(unknown.status).toBe(404); // 404 BEFORE auth (engine order)
    expect(unknown.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  // [P1.5 fold] WHOLE assertion flips: legacy feeds the non-uuid straight into the pg uuid cast
  // inside resolveProjectAccess → REJECTS (raw framework 500, S003 class). Fold = clean 400 via
  // zPublicId (sanctioned diff C).
  it("non-uuid id → legacy pg uuid-cast throw (frozen defensive form)", async () => {
    signedOut();
    await expect(exp("not-a-uuid")).rejects.toThrow();
  });
});
