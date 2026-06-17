// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION — POST /api/pages/textract-rerun (force-refresh one page's
// Textract). Freezes: dbId body `projectId` + the additive `publicId`; NO allowDemo (demo blocked);
// the gate order (field → access → no-dataUrl 404 → page 404 → S3 → Textract → write); the
// distinct S3-download 500 (kept specific, non-leaking); the SANCTIONED leak-drop on the Textract
// failure (now generic); and the stats response shape. S3 + Textract are mocked.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return { ...orig, downloadFromS3: vi.fn() };
});
vi.mock("@/lib/textract", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/textract")>();
  return { ...orig, analyzePageImageWithFallback: vi.fn() };
});

import { POST } from "@/app/api/pages/textract-rerun/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { downloadFromS3 } from "@/lib/s3";
import { analyzePageImageWithFallback } from "@/lib/textract";
import { asUser, createPage, createUser, createWorld, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const FAKE_TD = { words: [{}, {}], lines: [{}], tables: [] };
const req = (body: unknown) => POST(makeReq("/api/pages/textract-rerun", { method: "POST", body }));

beforeEach(() => {
  vi.mocked(downloadFromS3).mockReset();
  vi.mocked(downloadFromS3).mockResolvedValue(Buffer.from("png") as any);
  vi.mocked(analyzePageImageWithFallback).mockReset();
  vi.mocked(analyzePageImageWithFallback).mockResolvedValue(FAKE_TD as any);
});

describe.skipIf(!dbUp)("POST /api/pages/textract-rerun", () => {
  it("happy: re-runs textract, writes the row, returns the stats shape", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.durationMs).toBe("number");
    expect(body.stats).toEqual({ wordCount: 2, lineCount: 1, tableCount: 0 });
    expect(body.textractData).toEqual(FAKE_TD);
    const [r] = await db.select({ td: pages.textractData }).from(pages).where(eq(pages.id, page.id)).limit(1);
    expect(r?.td).toEqual(FAKE_TD);
  });

  it("ADDITIVE: accepts the new publicId field", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const { status } = await readJson(await req({ publicId: project.publicId, pageNumber: 1 }));
    expect(status).toBe(200);
  });

  it("SANCTIONED diff C: a non-uuid publicId → 400 'Invalid project id' (was pg-uuid-cast 500)", async () => {
    // [detector-review jun17] locks diff C on the NEW additive publicId branch (resolveByPublicId).
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ publicId: "not-a-uuid", pageNumber: 1 }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("SANCTIONED diff D: a non-integer dbId projectId → 400 'Invalid project id' (was pg int-cast 500)", async () => {
    // [detector-review jun17] resolveByDbId's Number.isInteger(>0) guard (services/pages.ts:74-78) had
    // ZERO coverage — without this, regressing it back to a pg int-cast 500 keeps the suite green.
    // (0 is excluded: it is falsy → trips the field-400 instead, exercised by "missing pageNumber".)
    const { user } = await createWorld();
    asUser(user);
    for (const bad of ["abc", 3.14, -5]) {
      const { status, body } = await readJson(await req({ projectId: bad, pageNumber: 1 }));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
    }
  });

  it("no dataUrl → 404 'Project has no dataUrl' (before the page check)", async () => {
    // dataUrl is non-nullable on insert; "" is the falsy value that trips the `!project.dataUrl` gate.
    const { user, project } = await createWorld({ dataUrl: "" });
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(404);
    expect(body.error.message).toBe("Project has no dataUrl");
  });

  it("page not found → 404 'Page not found'", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 5 }));
    expect(status).toBe(404);
    expect(body.error.message).toBe("Page not found");
  });

  it("S3 download failure → 500 with the specific (non-leaking) message", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    vi.mocked(downloadFromS3).mockRejectedValueOnce(new Error("s3 timeout xyz"));
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Failed to load page image from S3" });
  });

  it("SANCTIONED leak-drop: a Textract failure → generic 500, secret absent", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    vi.mocked(analyzePageImageWithFallback).mockRejectedValueOnce(new Error("AWS_SECRET detail"));
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("AWS_SECRET");
  });

  it("missing pageNumber → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Missing projectId or pageNumber" });
  });

  it("demo blocked (NO allowDemo): signed-out demo caller → 401 (auth precedence, before any 404)", async () => {
    // [detector-review jun17] tightened from expect([401,404]).toContain — resolveProjectAccess with
    // no allowDemo hits the UNAUTHORIZED branch deterministically before any not-found, on legacy + new.
    const { project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1);
    signedOut();
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("cross-tenant → 404", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1);
    asUser(await createUser((await createWorld()).company.id));
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("malformed JSON → 400 BAD_REQUEST", async () => {
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/textract-rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("empty body → 400 VALIDATION (zLooseBody rejects undefined; legacy threw → 500)", async () => {
    // [detector-review jun17] sanctioned diff E sub-case: empty text → undefined → VALIDATION (distinct
    // from the malformed-JSON BAD_REQUEST). Pre-refactor this route had no try/catch → unhandled 500.
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/textract-rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });
});
