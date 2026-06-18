// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for GET /api/projects/[id]/pages —
// the chunk-loader window contract (useChunkLoader.ts:78). This payload shape
// is what P2.2⑦ re-implements as the pagesWindow query; freeze it exactly,
// including the annotation visibility rule: a member sees THEIR OWN
// annotations plus project-scoped machine sources (yolo / shape-parse /
// symbol-search) — but NOT another user's hand-drawn ones.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/projects/[id]/pages/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
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

function windowReq(publicId: string, from: number | string, to: number | string) {
  return makeReq(`/api/projects/${publicId}/pages?from=${from}&to=${to}`, { method: "GET" });
}

async function seedAnnotation(projectId: number, pageNumber: number, creatorId: number, source: string, name: string) {
  await db.insert(annotations).values({
    projectId, pageNumber, creatorId, source, name,
    minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2,
  });
}

describe.skipIf(!dbUp)("GET /api/projects/[id]/pages (chunk window)", () => {
  it("returns the window payload shape with per-page jsonb fields", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { keynotes: { K1: "demising wall" } as any });
    await createPage(project.id, 2);
    await createPage(project.id, 9); // outside window
    asUser(user);

    const { status, body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(status).toBe(200);
    expect(body.from).toBe(1);
    expect(body.to).toBe(8);
    expect(body.pages).toHaveLength(2);
    expect(body.pages[0]).toEqual({
      pageNumber: 1,
      name: "Page 1",
      drawingNumber: null,
      keynotes: { K1: "demising wall" },
      csiCodes: null,
      textAnnotations: null,
      pageIntelligence: null,
    });
  });

  it("range validation: to<from, from<1, window>50 → 400; defaults from=1 to=9", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 3);
    asUser(user);
    for (const [f, t] of [[5, 2], [0, 5], [1, 52]] as const) {
      const { status, body } = await readJson(await GET(windowReq(project.publicId, f, t), params({ id: project.publicId })));
      expect(status).toBe(400);
      // [P1.5 fold] envelope flip {error:string} → {error:{code,message}}; message verbatim.
      expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid range. Max 50 pages per request." });
    }
    const def = await readJson(
      await GET(makeReq(`/api/projects/${project.publicId}/pages`, { method: "GET" }), params({ id: project.publicId })),
    );
    expect(def.status).toBe(200);
    expect([def.body.from, def.body.to]).toEqual([1, 9]);
  });

  it("non-numeric from/to → 400 (parseInt NaN branch)", async () => {
    // [P1.5 fold] new coverage of the isNaN branch. A present-but-non-numeric param does NOT hit the
    // `|| "1"` default (the value is non-empty) → parseInt → NaN → 400. Legacy returned the same 400
    // string body; status is stable, only the envelope flips.
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    for (const q of ["from=abc&to=5", "from=1&to=xyz"]) {
      const { status, body } = await readJson(
        await GET(makeReq(`/api/projects/${project.publicId}/pages?${q}`, { method: "GET" }), params({ id: project.publicId })),
      );
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid range. Max 50 pages per request." });
    }
  });

  it("annotation visibility: own + machine sources, NOT another member's hand-drawn", async () => {
    const { user, project, company } = await createWorld();
    const teammate = await createUser(company.id);
    await createPage(project.id, 1);
    await seedAnnotation(project.id, 1, user.id, "user", "mine");
    await seedAnnotation(project.id, 1, teammate.id, "user", "theirs"); // hidden from `user`
    await seedAnnotation(project.id, 1, teammate.id, "yolo", "machine-yolo"); // visible (project-scoped)
    await seedAnnotation(project.id, 1, teammate.id, "symbol-search", "machine-symbol"); // visible
    asUser(user);

    const { body } = await readJson(await GET(windowReq(project.publicId, 1, 5), params({ id: project.publicId })));
    const names = body.annotations.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(["machine-symbol", "machine-yolo", "mine"]);
    expect(body.annotations[0].bbox).toHaveLength(4);
  });

  // ── [refactor jun18 P1.5] freeze-expansion before the getPageWindow fold ──────────────────
  // The cases below freeze the AUTH surface + the Cache-Control header + the non-uuid quirk that
  // the original P0.3 happy-path test did not cover. They assert CURRENT legacy behavior (run
  // GREEN vs the legacy route in the freeze commit); the assertions tagged `[P1.5 fold]` flip to
  // the {code,message} envelope (or 400) in the fold commit. The status codes + Cache-Control +
  // 200 payload shape are STABLE across the fold (only sanctioned diffs A/B/C apply).

  it("sets Cache-Control on the 200 — perf-relevant; must survive the shell via the raw-NextResponse passthrough", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const res = await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300, stale-while-revalidate=600");
  });

  it("signed-out → 401 (this authed route passes NO allowDemo)", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1);
    signedOut();
    const { status, body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(status).toBe(401);
    expect(body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" }); // [P1.5 fold]
  });

  it("range 400 fires BEFORE the auth 401 — validate-before-auth precedence (why the shell stays auth:\"none\")", async () => {
    const { project } = await createWorld();
    signedOut();
    // invalid range while signed-out → 400 (range), NOT 401 (auth). Freezes the ordering.
    const { status, body } = await readJson(await GET(windowReq(project.publicId, 5, 2), params({ id: project.publicId })));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid range. Max 50 pages per request." }); // [P1.5 fold]
  });

  it("cross-company member → 404 (tenant isolation, no existence leak)", async () => {
    const { project } = await createWorld(); // company A
    await createPage(project.id, 1);
    const otherCo = await createCompany();
    const intruder = await createUser(otherCo.id);
    asUser(intruder);
    const { status, body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold]
  });

  it("root admin sees another company's window — root bypass → 200", async () => {
    const { project } = await createWorld(); // company A
    await createPage(project.id, 1);
    const otherCo = await createCompany();
    const root = await createUser(otherCo.id, { isRootAdmin: true });
    asUser(root);
    const { status, body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(status).toBe(200);
    expect(body.pages).toHaveLength(1);
  });

  it("demo project, signed-out → 401 (this route never serves demo publicly — that is the demo twin's job)", async () => {
    const { project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1);
    signedOut();
    const { status } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(status).toBe(401); // no allowDemo → demo falls through to the require-auth 401
  });

  it("non-uuid id → 400 VALIDATION (sanctioned diff C; legacy was a pg-uuid-cast 500)", async () => {
    // [P1.5 fold] resolveByPublicId's zPublicId turns the raw pg-cast 500 into a clean 400. The range
    // (1,8) is valid so the range gate passes first; the id is then rejected at the access step.
    // Pre-fold the route THREW (frozen as rejects.toThrow in the freeze commit 0c4b180).
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await GET(windowReq("not-a-uuid", 1, 8), params({ id: "not-a-uuid" })),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  // ── [refactor jun18 P1.5] DETECTOR freeze-tightening closers (wf_65e55f39-625) ────────────────
  // The adversarial review found the original freeze loose in 5 spots (0 code defects). These pin
  // the remaining sanctioned diff + frozen quirks so a future drift surfaces RED.

  it("unexpected DB error → leak-free INTERNAL 500 (sanctioned diff B; legacy had NO try/catch → raw leaky 500)", async () => {
    // The shell's outer catch (defineRoute.ts:253-263) logs the real cause server-side and returns a
    // GENERIC body — the thrown err.message must NEVER reach the client. Mirrors the S018 closer.
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const spy = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("boom: SECRET connection string leaked here");
    });
    try {
      const { status, body } = await readJson(
        await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })),
      );
      expect(status).toBe(500);
      expect(body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
      expect(JSON.stringify(body)).not.toContain("boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("page jsonb/text fields round-trip NON-null verbatim (|| null only coalesces the falsy case)", async () => {
    const { user, project } = await createWorld();
    const csi = [{ code: "09 51 00", description: "Acoustical Ceilings", division: "09", trade: "Finishes" }];
    const ta = { lines: [{ text: "DETAIL", bbox: [0, 0, 1, 1] }] };
    const pi = { parsedRegions: [{ id: "r1" }] };
    await createPage(project.id, 1, {
      drawingNumber: "A-101",
      csiCodes: csi as any,
      textAnnotations: ta as any,
      pageIntelligence: pi as any,
    });
    asUser(user);
    const { body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(body.pages[0]).toEqual({
      pageNumber: 1,
      name: "Page 1",
      drawingNumber: "A-101",
      keynotes: null, // not seeded → raw passthrough of DB null
      csiCodes: csi, // raw passthrough (no coalesce)
      textAnnotations: ta, // truthy → || null keeps it
      pageIntelligence: pi, // truthy → || null keeps it
    });
  });

  it("annotation output: full 6-field shape, bbox order [minX,minY,maxX,maxY], raw note, data uses ?? null (not || null)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    // binary-exact float4 values so the bbox round-trips without float precision drift.
    const [full] = await db
      .insert(annotations)
      .values({
        projectId: project.id, pageNumber: 1, creatorId: user.id, source: "user", name: "detail-a",
        minX: 0.5, minY: 0.25, maxX: 0.75, maxY: 0.125, note: "see RCP", data: { tool: "rect" } as any,
      })
      .returning();
    // data = falsy-but-present (false) → pins `?? null` (a `|| null` would wrongly drop it to null).
    await db.insert(annotations).values({
      projectId: project.id, pageNumber: 1, creatorId: user.id, source: "user", name: "falsy-data",
      minX: 0, minY: 0, maxX: 0, maxY: 0, note: null, data: false as any,
    });
    asUser(user);
    const { body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    const byName = Object.fromEntries(body.annotations.map((a: { name: string }) => [a.name, a]));
    expect(byName["detail-a"]).toEqual({
      id: full.id,
      pageNumber: 1,
      name: "detail-a",
      bbox: [0.5, 0.25, 0.75, 0.125],
      note: "see RCP",
      source: "user",
      data: { tool: "rect" },
    });
    expect(byName["falsy-data"].data).toBe(false); // ?? null keeps false
    expect(byName["falsy-data"].note).toBeNull(); // raw note passthrough keeps null
  });

  it("accepts the INCLUSIVE range boundaries: from===to (single page) and to-from===50 (exactly the cap) → 200", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 3);
    asUser(user);
    const single = await readJson(await GET(windowReq(project.publicId, 3, 3), params({ id: project.publicId })));
    expect(single.status).toBe(200);
    expect(single.body.pages).toHaveLength(1);
    const wide = await readJson(await GET(windowReq(project.publicId, 1, 51), params({ id: project.publicId })));
    expect(wide.status).toBe(200); // to-from===50 is allowed (> 50 rejects)
    expect([wide.body.from, wide.body.to]).toEqual([1, 51]);
  });

  it("orders pages ASCending by pageNumber regardless of insertion order", async () => {
    const { user, project } = await createWorld();
    // insert OUT of order so a dropped .orderBy(pageNumber) would surface as a RED test.
    await createPage(project.id, 2);
    await createPage(project.id, 1);
    asUser(user);
    const { body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(body.pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([1, 2]);
  });
});
