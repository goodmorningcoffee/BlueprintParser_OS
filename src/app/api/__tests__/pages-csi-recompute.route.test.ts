// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION — POST /api/pages/csi-recompute (re-run CSI detection from
// stored Textract). Freezes: dbId body `projectId` + the additive `publicId`; NO allowDemo; gate
// order (field → access → page 404 → no-OCR-data 400 → detect → write); the rawText fallback via
// extractRawText; the stats shape (codeCount/triggerCount/tradeCount); the em-dash (U+2014) in the
// no-OCR-data message; and the SANCTIONED leak-drop on a detect failure (now generic). detectCsiCodes
// is mocked so the route WIRING is frozen; extractRawText stays real.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/csi-detect", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-detect")>();
  return { ...orig, detectCsiCodes: vi.fn() };
});

import { POST } from "@/app/api/pages/csi-recompute/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { detectCsiCodes } from "@/lib/csi-detect";
import { asUser, createCompany, createPage, createUser, createWorld, makeReq, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// codeCount=3, triggerCount=2+1+0=3, tradeCount=distinct(Drywall,HVAC)=2
const FIXTURE = [
  { code: "09 21 16", trade: "Drywall", triggers: [{}, {}] },
  { code: "09 51 00", trade: "Drywall", triggers: [{}] },
  { code: "23 00 00", trade: "HVAC", triggers: [] },
];
const TD = { words: [{ text: "GYP" }], lines: [], tables: [] };
const req = (body: unknown) => POST(makeReq("/api/pages/csi-recompute", { method: "POST", body }));

beforeEach(() => {
  vi.mocked(detectCsiCodes).mockReset();
  vi.mocked(detectCsiCodes).mockReturnValue(FIXTURE as any);
});

describe.skipIf(!dbUp)("POST /api/pages/csi-recompute", () => {
  it("happy: detects, writes csiCodes, returns the stats shape", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, { textractData: TD as any, rawText: "GYP BOARD" });
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.durationMs).toBe("number");
    expect(body.stats).toEqual({ codeCount: 3, triggerCount: 3, tradeCount: 2 });
    expect(body.csiCodes).toEqual(FIXTURE);
    const [r] = await db.select({ csi: pages.csiCodes }).from(pages).where(eq(pages.id, page.id)).limit(1);
    expect(r?.csi).toEqual(FIXTURE);
  });

  it("ADDITIVE: accepts the new publicId field", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: TD as any, rawText: "x" });
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
    // [detector-review jun17] resolveByDbId's Number.isInteger(>0) guard — which lives in
    // server/api/access.ts, hoisted out of services/pages.ts by PR-C1 — had ZERO coverage.
    // (0 excluded: falsy → trips the field-400, exercised by "missing pageNumber".)
    const { user } = await createWorld();
    asUser(user);
    for (const bad of ["abc", 3.14, -5]) {
      const { status, body } = await readJson(await req({ projectId: bad, pageNumber: 1 }));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
    }
  });

  it("rawText fallback: rawText null → extractRawText re-derives, still 200", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: { words: [], lines: [], tables: [] } as any, rawText: null });
    asUser(user);
    const { status } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(200);
  });

  it("page not found → 404 'Page not found'", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 9 }));
    expect(status).toBe(404);
    expect(body.error.message).toBe("Page not found");
  });

  it("no OCR data → 400 with the EXACT em-dash message", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: null });
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(400);
    // em-dash is U+2014 — byte-exact
    expect(body.error).toEqual({ code: "VALIDATION", message: "Page has no OCR data — run textract-rerun first" });
  });

  it("SANCTIONED leak-drop: a detect failure → generic 500, detail absent", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: TD as any, rawText: "x" });
    vi.mocked(detectCsiCodes).mockImplementationOnce(() => {
      throw new Error("INTERNAL_DETAIL boom");
    });
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("INTERNAL_DETAIL");
  });

  it("missing pageNumber → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.id }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Missing projectId or pageNumber" });
  });

  it("L5 freeze: demo CSI recompute denies all roles before detection or page writes", async () => {
    const { company, project } = await createWorld();
    const original = [{ code: "PRIVATE-CANARY" }];
    const page = await createPage(project.id, 1, {
      textractData: TD as any,
      rawText: "x",
      csiCodes: original as any,
    });
    await publishDemoFixture(project.id);
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const statuses: number[] = [];
    for (const actor of [null, member, admin, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push((await readJson(await req({ projectId: project.id, pageNumber: 1 }))).status);
    }
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(detectCsiCodes).not.toHaveBeenCalled();
    const [row] = await db.select({ csiCodes: pages.csiCodes }).from(pages).where(eq(pages.id, page.id));
    expect(row.csiCodes).toEqual(original);
  });

  it("cross-tenant → 404", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1, { textractData: TD as any, rawText: "x" });
    asUser(await createUser((await createWorld()).company.id));
    const { status, body } = await readJson(await req({ projectId: project.id, pageNumber: 1 }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("malformed JSON → 400 BAD_REQUEST", async () => {
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/csi-recompute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("empty body → 400 VALIDATION (zLooseBody rejects undefined; legacy threw → 500)", async () => {
    // [detector-review jun17] sanctioned diff E sub-case: empty text → undefined → VALIDATION 400.
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/csi-recompute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });
});
