// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION — GET /api/pages/textract (lazy per-page textract load).
// Freezes: dbId via ?projectId=<numeric> + the additive ?publicId=; the PERF-SACRED Cache-Control
// header (must survive the shell's raw-Response passthrough); the 200-on-missing-page quirk (NEVER
// a 404); allowDemo reads. Post-migration envelope.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/pages/textract/route";
import { asUser, createPage, createUser, createWorld, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const SEED = { words: [{ text: "GYP" }], lines: [], tables: [] };
const get = (qs: string) => GET(makeReq(`/api/pages/textract?${qs}`, { method: "GET" }));

describe.skipIf(!dbUp)("GET /api/pages/textract", () => {
  it("happy: returns the page's textractData + Cache-Control header", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: SEED as any });
    asUser(user);
    const res = await get(`projectId=${project.id}&pageNumber=1`);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600"); // PERF-SACRED
    const { status, body } = await readJson(res);
    expect(status).toBe(200);
    expect(body).toEqual({ textractData: SEED });
  });

  it("FROZEN 200-on-missing-page: returns {textractData:null} at 200 (NOT 404) + header", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const res = await get(`projectId=${project.id}&pageNumber=42`);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    const { status, body } = await readJson(res);
    expect(status).toBe(200);
    expect(body).toEqual({ textractData: null });
  });

  it("ADDITIVE: accepts ?publicId= (dual-ID unification)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { textractData: SEED as any });
    asUser(user);
    const { status, body } = await readJson(await get(`publicId=${project.publicId}&pageNumber=1`));
    expect(status).toBe(200);
    expect(body).toEqual({ textractData: SEED });
  });

  it("allowDemo: a signed-out reader can fetch a demo project's textract", async () => {
    const { project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1, { textractData: SEED as any });
    signedOut();
    const { status, body } = await readJson(await get(`projectId=${project.id}&pageNumber=1`));
    expect(status).toBe(200);
    expect(body).toEqual({ textractData: SEED });
  });

  it("missing pageNumber → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await get(`projectId=${project.id}`));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Missing projectId or pageNumber" });
  });

  it("cross-tenant (non-demo) → 404", async () => {
    const { project } = await createWorld();
    const other = await createUser((await createWorld()).company.id);
    asUser(other);
    const { status, body } = await readJson(await get(`projectId=${project.id}&pageNumber=1`));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("non-demo signed out → 401", async () => {
    const { project } = await createWorld();
    signedOut();
    const { status, body } = await readJson(await get(`projectId=${project.id}&pageNumber=1`));
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("non-uuid publicId → 400 VALIDATION 'Invalid project id'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await get(`publicId=not-a-uuid&pageNumber=1`));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("FROZEN NaN-query quirk: a present-but-non-numeric/zero ?projectId → field-400 (before access)", async () => {
    // [detector-review jun17] getPageTextract reads ?projectId via Number(searchParams) with NO zod
    // query schema (services/pages.ts:204-217 — deliberate: z.coerce would change this). Number("abc")
    // =NaN and Number("0")=0 are BOTH falsy → the field-400 "Missing projectId or pageNumber" fires
    // BEFORE resolveByDbId's "Invalid project id" AND before the access branch. Pin the message + its
    // precedence so a future query-schema "cleanup" can't silently alter the PERF-SACRED GET.
    const { user } = await createWorld();
    asUser(user);
    for (const qs of ["projectId=abc&pageNumber=1", "projectId=0&pageNumber=1"]) {
      const { status, body } = await readJson(await get(qs));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Missing projectId or pageNumber" });
    }
  });
});
