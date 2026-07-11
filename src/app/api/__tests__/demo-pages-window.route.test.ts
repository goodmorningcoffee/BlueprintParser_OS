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
//   • non-uuid id: legacy had no catch → pg uuid-cast THREW (S003 class). Now a clean 400
//     "Invalid project id" AFTER the range gate (sanctioned diff C).
// Assertions tagged [P1.5 fold] were flipped in the fold commit from the legacy {error:string}
// envelope to {error:{code,message}} (sanctioned diff A); the freeze form is at commit 87199c4.
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/demo/projects/[id]/pages/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { serializePageWindowIntelligence } from "@/server/services/page-window-serialization";
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

function s4PageIntelligenceFixture() {
  return {
    classifiedRegions: { tables: [{ id: "server-classified" }] },
    yoloHeatmap: { confidentRegions: [{ id: "server-heatmap" }] },
    csiSpatialMap: { summary: "server spatial context", zones: [] },
    autoTableProposals: [{ id: "legacy-proposal" }],
    ensembleRegions: [{ id: "ensemble-1", category: "door-schedule", tableProbability: 0.94 }],
    parsedRegions: [{ id: "user-region", type: "schedule", data: { rows: [{ Mark: "D1" }] } }],
    rejectedTextRegionIds: ["user-rejected-1"],
    classification: { discipline: "architectural" },
    unknownFutureKey: { nested: ["must", "survive"] },
  };
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

  it("S4 trims exactly four top-level PI keys while retaining ensemble/user/unknown and legacy JSON shapes", async () => {
    const { project } = await createWorld({ isDemo: true });
    const source = s4PageIntelligenceFixture();
    const legacyArray = [{ yoloHeatmap: "nested value survives because the top-level is an array" }];
    await createPage(project.id, 1, { pageIntelligence: source as any });
    await createPage(project.id, 2, { pageIntelligence: legacyArray as any });
    await createPage(project.id, 3, { pageIntelligence: "legacy-scalar" as any });
    await createPage(project.id, 4, { pageIntelligence: false as any });
    signedOut();

    const res = await win(project.publicId, "?from=1&to=4");
    expect(res.headers.get("cache-control")).toBeNull();
    const { status, body } = await readJson(res);
    expect(status).toBe(200);
    const byPage = Object.fromEntries(
      body.pages.map((page: { pageNumber: number; pageIntelligence: unknown }) => [page.pageNumber, page.pageIntelligence]),
    );

    expect(byPage[1]).toEqual({
      ensembleRegions: source.ensembleRegions,
      parsedRegions: source.parsedRegions,
      rejectedTextRegionIds: source.rejectedTextRegionIds,
      classification: source.classification,
      unknownFutureKey: source.unknownFutureKey,
    });
    expect(byPage[1]).not.toHaveProperty("classifiedRegions");
    expect(byPage[1]).not.toHaveProperty("yoloHeatmap");
    expect(byPage[1]).not.toHaveProperty("csiSpatialMap");
    expect(byPage[1]).not.toHaveProperty("autoTableProposals");
    expect(byPage[2]).toEqual(legacyArray);
    expect(byPage[3]).toBe("legacy-scalar");
    expect(byPage[4]).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(byPage[1]))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(source)),
    );

    // The helper is pure even when a caller hands it a frozen DB-shaped object. This protects the
    // server-only fields for later pipeline/context consumers while the demo wire value is slimmed.
    const frozen = Object.freeze(s4PageIntelligenceFixture());
    const direct = serializePageWindowIntelligence(frozen) as Record<string, unknown>;
    expect(direct).not.toBe(frozen);
    expect(frozen).toHaveProperty("classifiedRegions");
    expect(direct).not.toHaveProperty("classifiedRegions");
    expect(direct.ensembleRegions).toBe(frozen.ensembleRegions);
  });

  it("range 400 fires BEFORE the project lookup, message verbatim (NaN + to<from + >50 span)", async () => {
    signedOut();
    // unknown id + bad range → still the range 400 (proves precedence over the 404)
    const bad = await readJson(await win(randomUUID(), "?from=abc&to=5"));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: "VALIDATION", message: "Invalid range. Max 50 pages per request." }); // [P1.5 fold] flipped (legacy: bare string)

    expect((await readJson(await win(randomUUID(), "?from=5&to=4"))).status).toBe(400);
    expect((await readJson(await win(randomUUID(), "?from=1&to=52"))).status).toBe(400); // span 51
  });

  it("non-demo project → 404 (isDemo gate, even for its owner); unknown uuid → 404", async () => {
    const { user, project } = await createWorld(); // isDemo: false
    await createPage(project.id, 1);
    asUser(user); // even the owning member can't read a non-demo project here
    const gated = await readJson(await win(project.publicId));
    expect(gated.status).toBe(404);
    expect(gated.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")

    signedOut();
    expect((await readJson(await win(randomUUID()))).status).toBe(404);
  });

  it("empty window → 200; to-from===50 accept boundary; absent params → frozen defaults from=1/to=9", async () => {
    const { project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1);
    signedOut();
    const { status, body } = await readJson(await win(project.publicId, "?from=40&to=45"));
    expect(status).toBe(200);
    expect(body.pages).toEqual([]);
    expect(body.annotations).toEqual([]);

    // [DETECTOR closer COV-4] the ACCEPT side of the span gate: to-from===50 (a 51-page window)
    // is the LARGEST allowed — an off-by-one tightening (>50 → >=50, or harmonizing to the authed
    // zPageRange 50-page-span cap) would fail here. Frozen verbatim from legacy.
    expect((await readJson(await win(project.publicId, "?from=1&to=51"))).status).toBe(200);

    // [DETECTOR closer COV-3] absent params exercise the frozen parseInt defaults ("1"/"9").
    const defaults = await readJson(await win(project.publicId, ""));
    expect(defaults.status).toBe(200);
    expect(defaults.body.from).toBe(1);
    expect(defaults.body.to).toBe(9);
  });

  // [P1.5 fold] WHOLE assertion flipped: legacy had no catch → the pg uuid-cast on a non-uuid id
  // REJECTED (frozen at 87199c4 as .rejects.toThrow()). Now sanctioned diff C: clean 400 via
  // zPublicId, gated AFTER the range check (so a bad range still wins — pinned below).
  it("non-uuid id → 400 'Invalid project id' (diff C; range-400 still wins over it)", async () => {
    signedOut();
    const { status, body } = await readJson(await win("not-a-uuid"));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
    // precedence: a bad RANGE on a non-uuid id still yields the RANGE message (range gate first)
    const range = await readJson(await win("not-a-uuid", "?from=5&to=4"));
    expect(range.body.error.message).toBe("Invalid range. Max 50 pages per request.");
  });
});
