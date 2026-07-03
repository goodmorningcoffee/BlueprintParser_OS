// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/demo/projects/[id]/pages, written as THE
// FREEZE before the P1.4-deferred fold onto services/pages.ts (getPageWindowDemo — the PUBLIC
// twin of S019's authed getPageWindow; DELIBERATELY ISOLATED, do NOT collapse them). Frozen:
//   • FULLY PUBLIC: no auth at all — signed-out and any authed user get identical responses.
//   • range parse/validation IDENTICAL text to the authed twin ("Invalid range. Max 50 pages per
//     request.", parseInt defaults from=1/to=9, NaN/from<1/to<from/to-from>50), fired BEFORE the
//     project lookup.
//   • project gate = and(publicId, isDemo=true) → NON-demo and unknown both 404 "Not found"
//     (UNLIKE the demo/labeling twin which returns [] — do not harmonize).
//   • 5-col page select + TWO SEPARATE try/catch "migration-safety" re-queries (textAnnotations,
//     pageIntelligence) merged as ||null maps — SEQUENTIAL, never collapsed into one select and
//     never Promise.all'd (the authed twin parallelizes; this one must not change).
//   • annotation visibility = isNull(creatorId) OR source ∈ {yolo, shape-parse, symbol-search} —
//     a demo visitor sees project-scoped + ALL machine annotations but NEVER a user's hand-drawn
//     (creatorId set + source "user"). Differs from the authed twin (own + machine).
//   • NO Cache-Control header (the authed twin's private,max-age=300 is absent here — pinned).
//   • non-uuid id: legacy had no catch → pg uuid-cast THREW (S003 class). Flips to a clean 400
//     at fold time (sanctioned diff C).
// Assertions tagged [P1.5 fold] flip from the legacy {error:string} envelope to
// {error:{code,message}} in the fold commit (sanctioned diff A).
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/demo/projects/[id]/pages/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import {
  asUser,
  createPage,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const win = (id: string, qs = "?from=1&to=9") =>
  GET(makeReq(`/api/demo/projects/${id}/pages${qs}`, { method: "GET" }), params({ id }));

async function seedAnnotation(
  projectId: number,
  pageNumber: number,
  over: Partial<typeof annotations.$inferInsert> = {},
) {
  const [row] = await db
    .insert(annotations)
    .values({
      name: "ann",
      minX: 1,
      minY: 2,
      maxX: 3,
      maxY: 4,
      pageNumber,
      projectId,
      source: "user",
      ...over,
    })
    .returning();
  return row;
}

describe.skipIf(!dbUp)("GET /api/demo/projects/[id]/pages", () => {
  it("happy (signed-out): {from,to,pages,annotations}, ||null maps, bbox order, NO Cache-Control", async () => {
    const { project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1, {
      drawingNumber: "A-101",
      keynotes: [{ k: 1 }] as never,
      csiCodes: [{ code: "03 30 00" }] as never,
      textAnnotations: [{ t: "x" }] as never,
      pageIntelligence: { summary: "s" } as never,
    });
    await createPage(project.id, 2); // bare page → textAnnotations/pageIntelligence fall to ||null
    const projAnn = await seedAnnotation(project.id, 1, { name: "proj-scoped", note: "n1" }); // null creator
    signedOut();

    const res = await win(project.publicId, "?from=1&to=2");
    expect(res.headers.get("cache-control")).toBeNull(); // frozen: PUBLIC twin has NO cache header
    const { status, body } = await readJson(res);
    expect(status).toBe(200);
    expect(body.from).toBe(1);
    expect(body.to).toBe(2);
    expect(body.pages).toHaveLength(2);
    expect(body.pages[0]).toEqual({
      pageNumber: 1,
      name: "Page 1",
      drawingNumber: "A-101",
      keynotes: [{ k: 1 }],
      csiCodes: [{ code: "03 30 00" }],
      textAnnotations: [{ t: "x" }],
      pageIntelligence: { summary: "s" },
    });
    expect(body.pages[1]).toMatchObject({
      pageNumber: 2,
      drawingNumber: null,
      textAnnotations: null, // || null (absent from the migration-safety map)
      pageIntelligence: null,
    });
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0]).toEqual({
      id: projAnn.id,
      pageNumber: 1,
      name: "proj-scoped",
      bbox: [1, 2, 3, 4], // [minX, minY, maxX, maxY]
      note: "n1",
      source: "user",
      data: null, // ?? null
    });
  });

  it("visibility: null-creator + machine sources IN; a user's hand-drawn OUT (frozen or())", async () => {
    const { user, project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1);
    await seedAnnotation(project.id, 1, { name: "null-creator" });
    await seedAnnotation(project.id, 1, { name: "yolo-owned", source: "yolo", creatorId: user.id });
    await seedAnnotation(project.id, 1, { name: "shape", source: "shape-parse", creatorId: user.id });
    await seedAnnotation(project.id, 1, { name: "symbol", source: "symbol-search", creatorId: user.id });
    await seedAnnotation(project.id, 1, { name: "hand-drawn", source: "user", creatorId: user.id }); // EXCLUDED
    signedOut();

    const { status, body } = await readJson(await win(project.publicId, "?from=1&to=1"));
    expect(status).toBe(200);
    const names = body.annotations.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(["null-creator", "shape", "symbol", "yolo-owned"]); // no "hand-drawn"
  });

  it("range 400 fires BEFORE the project lookup, message verbatim (NaN + to<from + >50 span)", async () => {
    signedOut();
    // unknown id + bad range → still the range 400 (proves precedence over the 404)
    const bad = await readJson(await win(randomUUID(), "?from=abc&to=5"));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Invalid range. Max 50 pages per request."); // [P1.5 fold] → {code:"VALIDATION",message:...}

    expect((await readJson(await win(randomUUID(), "?from=5&to=4"))).status).toBe(400);
    expect((await readJson(await win(randomUUID(), "?from=1&to=52"))).status).toBe(400); // span 51
  });

  it("non-demo project → 404 (isDemo gate, even for its owner); unknown uuid → 404", async () => {
    const { user, project } = await createWorld(); // isDemo: false
    await createPage(project.id, 1);
    asUser(user); // even the owning member can't read a non-demo project here
    const gated = await readJson(await win(project.publicId));
    expect(gated.status).toBe(404);
    expect(gated.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}

    signedOut();
    expect((await readJson(await win(randomUUID()))).status).toBe(404);
  });

  it("empty window → 200 with empty pages+annotations (no rows in range)", async () => {
    const { project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1);
    signedOut();
    const { status, body } = await readJson(await win(project.publicId, "?from=40&to=45"));
    expect(status).toBe(200);
    expect(body.pages).toEqual([]);
    expect(body.annotations).toEqual([]);
  });

  // [P1.5 fold] WHOLE assertion flips: legacy has no catch → the pg uuid-cast on a non-uuid id
  // REJECTS (raw framework 500 in prod, S003 class). Fold = clean 400 via zPublicId, gated AFTER
  // the range check (sanctioned diff C).
  it("non-uuid id → legacy pg uuid-cast throw (frozen defensive form)", async () => {
    signedOut();
    await expect(win("not-a-uuid")).rejects.toThrow();
  });
});
