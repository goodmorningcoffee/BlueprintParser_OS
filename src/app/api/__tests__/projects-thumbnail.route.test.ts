// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/projects/[id]/thumbnail/[page], written as
// THE FREEZE before the P1.5 migration onto services/pages.ts (getPageThumbnail). Frozen:
//   • validate-before-auth: the page-number 400 fires BEFORE resolveProjectAccess (so the shell
//     must stay auth:"none"; the service validates imperatively).
//   • LEGACY MIXED error content types: the two route-LOCAL errors ("Invalid page number" 400,
//     "Thumbnail not found" 404, "Not found" dataUrl-404) are PLAIN TEXT bodies via
//     `new NextResponse(string)`; the ACCESS errors (401/404) are JSON {error:string} from
//     api-utils. At fold time ALL become the {error:{code,message}} envelope (sanctioned diff A —
//     incl. a text→JSON content-type change on the route-local three; sole consumer is an
//     <img src> in PageSidebar.tsx:55 which never reads bodies).
//   • access = resolveProjectAccess({publicId}, {allowDemo:true}): demo projects are PUBLIC
//     thumbnails (signed-out 200); unknown project → 404 BEFORE auth (engine order); non-demo
//     signed-out → 401; cross-tenant non-root → 404; root cross-company → 200 bypass.
//   • the S3 key is the PADDED `thumbnails/page_NNNN.png` (String(n).padStart(4,"0") — the
//     repo convention; contrast [LB-1] in labeling/create which is unpadded).
//   • downloadFromS3 failure → 404 "Thumbnail not found" (NOT a 500 — the catch quirk).
//   • success: raw PNG bytes, Content-Type image/png, Cache-Control
//     "public, max-age=3600, stale-while-revalidate=86400" (AGGRESSIVE-CACHE header — must
//     survive the fold via the raw-NextResponse shell passthrough, the getPageTextract /
//     getPageWindow precedent).
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// Mock S3 — thumbnails never hit a live bucket in tests. Other exports are passthrough-mocked so
// the fold-time service module (and api-utils) load cleanly under the same mock.
const s3Mocks = vi.hoisted(() => ({
  downloadFromS3: vi.fn(),
  uploadToS3: vi.fn(),
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  getPresignedGetUrl: vi.fn(),
}));
vi.mock("@/lib/s3", () => s3Mocks);

import { GET } from "@/app/api/projects/[id]/thumbnail/[page]/route";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const thumb = (id: string, page: string) =>
  GET(
    makeReq(`/api/projects/${id}/thumbnail/${page}`, { method: "GET" }),
    params({ id, page }),
  );

const readText = async (res: Response) => ({ status: res.status, text: await res.text() });

describe.skipIf(!dbUp)("GET /api/projects/[id]/thumbnail/[page]", () => {
  it("happy: raw PNG bytes + image/png + the aggressive Cache-Control; PADDED S3 key", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    s3Mocks.downloadFromS3.mockResolvedValueOnce(png);

    const res = await thumb(project.publicId, "3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    // the PADDED key convention (page_0003, NOT page_3 — contrast labeling's [LB-1])
    expect(s3Mocks.downloadFromS3).toHaveBeenCalledWith(
      `${project.dataUrl}/thumbnails/page_0003.png`,
    );
  });

  it("invalid page (non-numeric / <1) → 400 BEFORE access (validate-before-auth, even signed-out)", async () => {
    signedOut();
    // legacy: TEXT body via new NextResponse(string)
    const nan = await readText(await thumb(randomUUID(), "abc"));
    expect(nan.status).toBe(400); // fires before the 404/401 — unknown project + signed out
    expect(nan.text).toBe("Invalid page number"); // [P1.5 fold] → JSON {error:{code:"VALIDATION",message:"Invalid page number"}}

    expect((await readText(await thumb(randomUUID(), "0"))).status).toBe(400);
  });

  it("access matrix: demo signed-out 200 (allowDemo); non-demo signed-out 401; cross-tenant 404; root bypass 200; unknown 404-before-auth", async () => {
    const png = Buffer.from([1]);

    const demo = await createWorld({ isDemo: true });
    signedOut();
    s3Mocks.downloadFromS3.mockResolvedValueOnce(png);
    expect((await thumb(demo.project.publicId, "1")).status).toBe(200); // PUBLIC demo thumbnail

    const world = await createWorld();
    signedOut();
    const noAuth = await readJson(await thumb(world.project.publicId, "1"));
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error).toBe("Unauthorized"); // [P1.5 fold] → {code:"UNAUTHORIZED",message:"Unauthorized"}

    asUser(await createUser((await createCompany()).id)); // cross-tenant member
    const cross = await readJson(await thumb(world.project.publicId, "1"));
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true })); // root bypass
    s3Mocks.downloadFromS3.mockResolvedValueOnce(png);
    expect((await thumb(world.project.publicId, "1")).status).toBe(200);

    signedOut(); // unknown project → 404 BEFORE auth (resolveProjectAccess engine order)
    const unknown = await readJson(await thumb(randomUUID(), "1"));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  it("downloadFromS3 failure → 404 'Thumbnail not found' (the catch quirk — NOT a 500)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    s3Mocks.downloadFromS3.mockRejectedValueOnce(new Error("NoSuchKey"));
    const { status, text } = await readText(await thumb(project.publicId, "1"));
    expect(status).toBe(404);
    expect(text).toBe("Thumbnail not found"); // [P1.5 fold] → JSON {error:{code:"NOT_FOUND",message:"Thumbnail not found"}}
  });
});
