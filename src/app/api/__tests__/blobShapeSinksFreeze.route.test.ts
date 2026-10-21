// @vitest-environment node
// [refactor jul23 P4.1 U0] COMMIT-A DRAFT — the U0 real-DB characterization FREEZE (test-only, RD-C).
//
// This file freezes the EXACT persisted jsonb of every ROUTE-REACHABLE annotation/region/page
// persistence SINK, round-tripped through the REAL route + service + Postgres path, BEFORE any
// P4.1 shape-registry validate-on-write wiring lands. It is the "must not silently reorder/strip"
// baseline that U1+ (log-mode sink validation, then the later canary→reject flip) refactors
// against. Nothing is mocked except @/lib/auth (the harness recipe) — the real drizzle inserts,
// mergeAutoCsi, mergeCsiCodes, and computeProjectSummaries all run against the test DB.
//
// Every writer-literal payload is lifted field-for-field from the verified writer sites in
// U0_RECON_RAW_2026-07-23.json (.result.{serverBlobs,clientBlobs1,clientBlobs2U1,regionsCsiZod};
// RD-I: that recon overrides ENTRY_RECON). Each `data` blob ALSO carries an unknown sentinel key
// (__freezeSentinel:"preserve") that MUST survive byte-identical — the ROUTE-persistence proof of
// the spec Verdict-1 passthrough contract. (annotationMarkupEditCacheFreeze.test.ts:29 pins the
// same contract on the CLIENT-CACHE side — a query-cache CAS freeze, not a route→Postgres one;
// the U0 review flagged the distinction, hence the empty-markup route pin below for U6.)
//
// Assertions are ORDER-INSENSITIVE on jsonb key order (Postgres jsonb normalizes key order): we
// use deep toEqual (order-independent for object props) PLUS an explicit sorted key-SET assertion
// so a stripped OR added key is caught either way. Arrays keep their order (jsonb preserves it).
//
// SCOPE BOUNDARY (do NOT add here): server-pipeline-only writers — yolo load (yolo.ts:583),
// SERVER shape-parse (processing.ts:504 / reprocess.ts:443,479), and the split halves
// (annotations.ts:485-502) — are OUT of scope. They never land through these client-facing
// routes on the persistable path (split POSTs a SplitAnnotationRequest, not the half blobs; yolo/
// processing run in the background pipeline). Their freezes belong to U7 / the split's own unit
// (annotations-split.route.test.ts already freezes the split halves). This file covers only the
// sinks reachable from POST /api/annotations (single+batch), PUT /api/annotations/[id],
// POST /api/regions/promote (Parser-Save), and PATCH /api/pages/intelligence.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/annotations/route";
import { PUT } from "@/app/api/annotations/[id]/route";
import { POST as PROMOTE_REGION } from "@/app/api/regions/promote/route";
import { PATCH as PATCH_INTELLIGENCE } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  annotationsFor,
  asUser,
  createPage,
  createWorld,
  makeReq,
  params,
  readJson,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const bbox = [0.1, 0.1, 0.3, 0.3];
const SENTINEL = "__freezeSentinel";

// ── real-route drivers (nothing mocked but auth) ───────────────────────────────────────────────
const postAnnotations = async (body: unknown) =>
  readJson(await POST(makeReq("/api/annotations", { body })));
const putAnnotation = async (id: number, body: unknown) =>
  readJson(
    await PUT(makeReq(`/api/annotations/${id}`, { method: "PUT", body }), params({ id: String(id) })),
  );
const promoteRegion = async (body: unknown) =>
  readJson(await PROMOTE_REGION(makeReq("/api/regions/promote", { body })));
const patchIntelligence = async (body: unknown) =>
  readJson(await PATCH_INTELLIGENCE(makeReq("/api/pages/intelligence", { method: "PATCH", body })));

const rowById = async (id: number) =>
  (await db.select().from(annotations).where(eq(annotations.id, id)))[0];

/** Read back the persisted page state (after the tx) — mirrors regions-promote.route.test.ts:61-70. */
const pageState = async (pageId: number) => {
  const [r] = await db
    .select({ pi: pages.pageIntelligence, csi: pages.csiCodes })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  const pi = (r?.pi ?? {}) as Record<string, any>;
  return { pi, csi: (r?.csi ?? []) as any[], regions: (pi.parsedRegions ?? []) as any[] };
};

/** Deep-equal PLUS an explicit sorted key-set assertion (the task's "toEqual + Object.keys set"). */
function expectDataExactly(actual: unknown, expected: Record<string, unknown>) {
  expect(actual).toEqual(expected);
  expect([...Object.keys(actual as Record<string, unknown>)].sort()).toEqual(
    [...Object.keys(expected)].sort(),
  );
}

// A note that reliably auto-detects CSI codes under the default engine (same phrase the sibling
// annotations.route.test.ts §6.2 uses: it detects the "033000" concrete/foundation code). The
// EXACT detected set below is pinned from OBSERVED behavior (not assumed) — it is the default
// builtin-masterformat output for this exact note at HEAD 454490c. A masterformat DB refresh is
// expected to move this set; update it in the same commit if so (this coupling is a deliberate
// canary — the sink freeze proves mergeAutoCsi preserves manual codes + Set-dedupes whatever
// detect returns, and the detected content itself is owned by csi-detect's own tests).
const TRIGGERING_NOTE =
  "Provide cast in place concrete for all foundation walls and footings.";
// [OBSERVED @HEAD 454490c] detectCsiCodes(TRIGGERING_NOTE).map(c => c.code) under the builtin CSI DB.
const AUTO_CODES = [
  "030130",
  "030130.51",
  "030130.61",
  "030130.71",
  "030130.72",
  "030630",
  "033000",
  "033053",
  "316213.13",
  "316616.23",
  "323213",
];

describe.skipIf(!dbUp)("[P4.1 U0] POST /api/annotations single — createAnnotationSingle sink (verbatim jsonb)", () => {
  // note null ⇒ mergeAutoCsi returns existingData unchanged (annotations.ts:87), so the client blob
  // persists BYTE-IDENTICAL, sentinel and all. This is the U1 target shape (scale-calibration).
  it("scale-calibration blob persists verbatim (incl. unknown sentinel); source=takeoff-scale", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "scale-calibration",
      point1: { x: 0.2, y: 0.3 },
      point2: { x: 0.7, y: 0.3 },
      realDistance: 10,
      unit: "ft", // AreaUnit ("ft"|"in"|"m"|"cm") — NOT AreaUnitSq (clientBlobs2U1)
      [SENTINEL]: "preserve",
    };
    const { status, body } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 3,
      name: "Scale (pg 3)",
      bbox,
      note: null,
      source: "takeoff-scale",
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.source).toBe("takeoff-scale");
    expectDataExactly(row.data, data);
    // The 200 response body echoes the same blob (toClientAnnotation: data: a.data ?? null).
    expectDataExactly(body.data, data);
    // [U0 review R2] single-POST OMITS threshold on insert (frozen quirk — batch sets it;
    // see the symbol-search batch test's 0.83 pin for the divergence's other half).
    expect(row.threshold).toBeNull();
  });

  // [U0 review R2] U6 pre-pin: the all-optional empty-markup shape ({} from llm/tools.ts:578;
  // client markup posts through this same single sink) — the route-persistence baseline the
  // U6 wiring will refactor against.
  it("empty-markup {} and a sentinel-only markup blob persist verbatim through the single sink", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status: s1, body: b1 } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "markup-empty",
      bbox,
      note: null,
      data: {},
    });
    expect(s1).toBe(200);
    expectDataExactly((await rowById(b1.id as number)).data, {});
    const sentinelOnly = { [SENTINEL]: "preserve" };
    const { status: s2, body: b2 } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "markup-sentinel",
      bbox,
      note: null,
      data: sentinelOnly,
    });
    expect(s2).toBe(200);
    expectDataExactly((await rowById(b2.id as number)).data, sentinelOnly);
  });

  it("count-marker blob persists verbatim (incl. sentinel)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "count-marker",
      shape: "circle", // TakeoffShape, narrowed by takeoffCount.ts:51 guard
      color: "#22aa44",
      takeoffItemId: 987, // item id (not annotation id); jsonb has no FK
      [SENTINEL]: "preserve",
    };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "count-marker",
      bbox,
      note: null,
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expectDataExactly(row.data, data);
  });

  it("area-polygon (NO holes) blob persists verbatim with unit:'SF' (AreaUnitSq)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "area-polygon",
      takeoffItemId: 42,
      color: "#3366ff",
      vertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.4, y: 0.1 },
        { x: 0.4, y: 0.4 },
      ],
      areaSqUnits: 64,
      unit: "SF", // AreaUnitSq ("SF"|"SI"|"SM"|"SC")
      [SENTINEL]: "preserve",
    };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 2,
      name: "area-no-holes",
      bbox,
      note: null,
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expectDataExactly(row.data, data);
    // vertices array order is preserved through jsonb.
    expect(row.data!.vertices).toEqual(data.vertices);
  });

  it("area-polygon (WITH holes) blob persists verbatim (holes deep-preserved)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "area-polygon",
      takeoffItemId: 42,
      color: "#3366ff",
      vertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      holes: [
        {
          vertices: [
            { x: 0.3, y: 0.3 },
            { x: 0.5, y: 0.3 },
            { x: 0.4, y: 0.5 },
          ],
        },
      ],
      areaSqUnits: 100,
      unit: "SF",
      [SENTINEL]: "preserve",
    };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 2,
      name: "area-with-holes",
      bbox,
      note: null,
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expectDataExactly(row.data, data);
    expect(row.data!.holes).toEqual(data.holes);
  });

  it("linear-polyline blob persists verbatim (unit is the LINEAR unit)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "linear-polyline",
      takeoffItemId: 7,
      color: "#00aa88",
      vertices: [
        { x: 0.1, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ],
      totalLength: 12.5,
      unit: "ft", // LinearPolylineData.unit (linear ft/in/m/cm), NOT AreaUnitSq
      segmentLengths: [12.5],
      [SENTINEL]: "preserve",
    };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 4,
      name: "linear",
      bbox,
      note: null,
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expectDataExactly(row.data, data);
    expect(row.data!.segmentLengths).toEqual(data.segmentLengths);
  });
});

describe.skipIf(!dbUp)("[P4.1 U0] mergeAutoCsi on create — annotations.ts:79-97 sink", () => {
  it("note-triggered create merges detected codes into data.csiCodes; preserves manual codes, sentinel, and every other key (shallow copy — only csiCodes touched)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "count-marker",
      shape: "circle",
      color: "#111",
      takeoffItemId: 5,
      csiCodes: ["03 30 00"], // manual code (string[] shape B)
      [SENTINEL]: "preserve",
    };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "auto-csi-existing",
      bbox,
      note: TRIGGERING_NOTE,
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    const persisted = row.data as Record<string, unknown>;
    // Only csiCodes is rewritten: manual entries retained, auto codes appended, Set-deduped.
    expect(persisted.csiCodes).toEqual(["03 30 00", ...AUTO_CODES]);
    // Sentinel + every non-csi key untouched (the shallow-copy semantics).
    expect(persisted[SENTINEL]).toBe("preserve");
    expect(persisted.type).toBe("count-marker");
    expect(persisted.shape).toBe("circle");
    expect(persisted.color).toBe("#111");
    expect(persisted.takeoffItemId).toBe(5);
    // Key SET unchanged (csiCodes was already present) — nothing stripped, nothing added.
    expect([...Object.keys(persisted)].sort()).toEqual([...Object.keys(data)].sort());
  });

  it("note-triggered create ADDS a csiCodes key when absent; all other keys + sentinel survive", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const data = {
      type: "count-marker",
      shape: "square",
      color: "#222",
      takeoffItemId: 6,
      [SENTINEL]: "preserve",
    };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "auto-csi-absent",
      bbox,
      note: TRIGGERING_NOTE,
      data,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    const persisted = row.data as Record<string, unknown>;
    expect(persisted.csiCodes).toEqual([...AUTO_CODES]); // freshly added
    expect(persisted[SENTINEL]).toBe("preserve");
    expect(persisted.type).toBe("count-marker");
    expect(persisted.color).toBe("#222");
    // [U0 review R2] value integrity on the remaining keys (key-set alone missed coercion).
    expect(persisted.shape).toBe("square");
    expect(persisted.takeoffItemId).toBe(6);
    // Key set = input keys + the newly added "csiCodes".
    expect([...Object.keys(persisted)].sort()).toEqual(
      [...Object.keys(data), "csiCodes"].sort(),
    );
  });
});

describe.skipIf(!dbUp)("[P4.1 U0] PUT /api/annotations/[id] — updateAnnotation merge (annotations.ts:559-596)", () => {
  // Seed a create (note null → verbatim), returning the row id for the PUT.
  const seed = async (projectPublicId: string, data: Record<string, unknown>) => {
    const { body } = await postAnnotations({
      projectId: projectPublicId,
      pageNumber: 1,
      name: "put-seed",
      bbox,
      note: null,
      data,
    });
    return body.id as number;
  };

  it("PUT with body.data and NO note REPLACES the whole blob — old sentinel/csiCodes are dropped, the new blob persists verbatim (annotations.ts:562)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, {
      type: "count-marker",
      color: "#old",
      csiCodes: ["03 30 00"],
      [SENTINEL]: "preserve",
    });
    const replacement = { type: "count-marker", color: "#new", replacedKey: true };
    const { status } = await putAnnotation(id, { data: replacement });
    expect(status).toBe(200);
    // Whole-blob overwrite: the ENTIRE data column is body.data. Old csiCodes AND old sentinel gone.
    expectDataExactly((await rowById(id)).data, replacement);
  });

  it("PUT note-only (auto-csi triggered, no body.data) MERGES detected codes into the EXISTING row data — sentinel + other keys survive, manual codes preserved (annotations.ts:585-595)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, {
      type: "count-marker",
      color: "#keep",
      csiCodes: ["03 30 00"],
      [SENTINEL]: "preserve",
    });
    const { status, body } = await putAnnotation(id, { note: TRIGGERING_NOTE });
    expect(status).toBe(200);
    expect(body.autoCsiCodes).toEqual([...AUTO_CODES]); // detection reported to the caller
    const persisted = (await rowById(id)).data as Record<string, unknown>;
    // Seeded from the existing row (updates.data undefined → annotation.data): manual + auto union.
    expect(persisted.csiCodes).toEqual(["03 30 00", ...AUTO_CODES]);
    expect(persisted[SENTINEL]).toBe("preserve"); // unknown key survives the in-place merge
    expect(persisted.type).toBe("count-marker");
    expect(persisted.color).toBe("#keep");
    expect([...Object.keys(persisted)].sort()).toEqual(
      ["type", "color", "csiCodes", SENTINEL].sort(),
    );
  });

  it("PUT with BOTH body.data and note — body.data replaces the blob, then detected codes merge into body.data.csiCodes (old sentinel gone, new key kept)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, {
      type: "count-marker",
      color: "#old",
      [SENTINEL]: "preserve",
    });
    const { status } = await putAnnotation(id, {
      data: { type: "count-marker", color: "#c", csiCodes: ["03 30 00"], newKey: "kept" },
      note: TRIGGERING_NOTE,
    });
    expect(status).toBe(200);
    const persisted = (await rowById(id)).data as Record<string, unknown>;
    // Base = body.data (old sentinel dropped); csiCodes = union(body.data.csiCodes, detected).
    expect(persisted.csiCodes).toEqual(["03 30 00", ...AUTO_CODES]);
    expect(persisted.newKey).toBe("kept");
    expect(persisted.color).toBe("#c");
    expect(persisted[SENTINEL]).toBeUndefined();
    expect([...Object.keys(persisted)].sort()).toEqual(
      ["type", "color", "csiCodes", "newKey"].sort(),
    );
  });
});

describe.skipIf(!dbUp)("[P4.1 U0] POST /api/annotations batch — createAnnotationBatch sink", () => {
  it("symbol-search blob persists verbatim; delete-before-insert replaces prior symbol-search rows on the named pages (annotations.ts:231-243)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    // Seed an existing symbol-search row on page 4 (plain append, no delete).
    await postAnnotations({
      projectId: project.publicId,
      annotations: [
        {
          pageNumber: 4,
          name: "old-symbol",
          bbox,
          source: "symbol-search",
          threshold: 0.5,
          note: null,
          data: { modelName: "symbol-search", method: "template", confidence: 0.5, scale: 1 },
        },
      ],
    });
    // Now the real symbol-search batch: delete-before-insert on page 4.
    const symbolData = {
      modelName: "symbol-search",
      method: "ncc",
      confidence: 0.83,
      scale: 1,
      templateSourcePage: 2,
      [SENTINEL]: "preserve",
    };
    const { status, body } = await postAnnotations({
      projectId: project.publicId,
      deleteSource: "symbol-search",
      deletePageNumbers: [4],
      annotations: [
        {
          pageNumber: 4,
          name: "symbol-match",
          bbox,
          source: "symbol-search",
          threshold: 0.83,
          note: null,
          data: symbolData,
        },
      ],
    });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const rows = await annotationsFor(project.id);
    // old-symbol on page 4 deleted; only the freshly inserted symbol-match remains.
    expect(rows.map((r) => r.name)).toEqual(["symbol-match"]);
    expectDataExactly(rows[0].data, symbolData);
    expect(rows[0].threshold).toBe(0.83); // sibling threshold column (batch sets it; single omits)
  });

  it("client shape-parse blob persists verbatim; the batch is APPEND-ONLY (no deleteSource — prior rows survive)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    // Seed an existing shape-parse row on page 5.
    await postAnnotations({
      projectId: project.publicId,
      annotations: [
        {
          pageNumber: 5,
          name: "shape-a",
          bbox,
          source: "shape-parse",
          note: null,
          data: { modelName: "shape-parse", shapeType: "square", text: "K0", contour: [], confidence: 0.9 },
        },
      ],
    });
    const shapeData = {
      modelName: "shape-parse",
      shapeType: "circle",
      text: "K1",
      contour: [
        [0.1, 0.1],
        [0.2, 0.2],
      ],
      confidence: 0.9,
      [SENTINEL]: "preserve",
    };
    const { status, body } = await postAnnotations({
      projectId: project.publicId,
      // no deleteSource/deletePageNumbers → append-only (DetectionPanel client save semantics)
      annotations: [
        { pageNumber: 5, name: "shape-b", bbox, source: "shape-parse", note: null, data: shapeData },
      ],
    });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const rows = await annotationsFor(project.id);
    // Append-only: BOTH shape-a and shape-b survive.
    expect(rows.map((r) => r.name).sort()).toEqual(["shape-a", "shape-b"]);
    const b = rows.find((r) => r.name === "shape-b")!;
    expectDataExactly(b.data, shapeData);
    expect((b.data as Record<string, unknown>).contour).toEqual(shapeData.contour);
  });
});

describe.skipIf(!dbUp)("[P4.1 U0] POST /api/regions/promote — Parser-Save verbatim passthrough (regions.ts:285-286)", () => {
  it("persists a GRID-shaped client data blob EXACTLY (unvalidated verbatim passthrough)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const gridData = {
      headers: ["Mark", "Type"],
      rows: [{ Mark: "D1", Type: "Door" }],
      tagColumn: "Mark",
      tableName: "Door Schedule",
      rowCount: 1,
      columnCount: 2,
      colBoundaries: [0, 1],
      rowBoundaries: [0, 1],
      [SENTINEL]: "preserve",
    };
    const { status } = await promoteRegion({
      publicId: project.publicId,
      pageNumber: 1,
      type: "schedule",
      overrides: { bbox: [0.1, 0.2, 0.3, 0.4], data: gridData, regionId: "grid-1" },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
    expectDataExactly(st.regions[0].data, gridData);
    // Parser-Save stores overrides.bbox verbatim (NO LTWH→MinMax conversion — that's Classifier-only).
    expect(st.regions[0].bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("persists an ARBITRARILY-shaped client data blob EXACTLY (deep nesting preserved)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const weirdData = {
      anything: { nested: { deep: [1, 2, 3] } },
      weird: "value",
      num: 42,
      flag: false,
      [SENTINEL]: "preserve",
    };
    const { status } = await promoteRegion({
      publicId: project.publicId,
      pageNumber: 1,
      type: "legend",
      overrides: { bbox: [0, 0, 1, 1], data: weirdData, regionId: "weird-1" },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
    expectDataExactly(st.regions[0].data, weirdData);
  });
});

describe.skipIf(!dbUp)("[P4.1 U0] PATCH /api/pages/intelligence — shallow-merge sink (pages.ts updatePageIntelligence)", () => {
  it("shallow-merges pageIntelligence: sibling keys survive, a nested object under a shared key is REPLACED WHOLESALE (not deep-merged)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: {
        textRegions: [{ id: "keep-tr" }],
        nested: { a: 1, b: 2 },
        customKey: 42,
      } as any,
    });
    asUser(user);
    const { status } = await patchIntelligence({
      publicId: project.publicId,
      pageNumber: 1,
      intelligence: { nested: { c: 3 }, extraKey: "new" },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    expect(st.pi.textRegions).toEqual([{ id: "keep-tr" }]); // sibling preserved (...existing spread)
    expect(st.pi.customKey).toBe(42); // sibling preserved
    expect(st.pi.nested).toEqual({ c: 3 }); // SHALLOW: replaced wholesale, NOT {a:1,b:2,c:3}
    expect(st.pi.extraKey).toBe("new"); // new top-level key added
  });

  it("merges parsedRegions.csiTags into pages.csiCodes via mergeCsiCodes; format-variant '081113' is deduped against existing '08 11 13' [refactor jul23 P4.1 U9 fix — was the raw-code double-write BUG]", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      csiCodes: [{ code: "08 11 13", description: "existing door", division: "08", trade: "" }] as any,
    });
    asUser(user);
    const { status } = await patchIntelligence({
      publicId: project.publicId,
      pageNumber: 1,
      intelligence: {
        parsedRegions: [
          {
            csiTags: [
              { code: "081113", description: "raw-form dup" }, // SAME logical code as "08 11 13"
              { code: "23 05 00", description: "new hvac" },
            ],
          },
        ],
      },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    // [refactor jul23 P4.1 U9 fix] mergeCsiCodes now dedupes on csiDedupeKey (separator-strip-only):
    // csiDedupeKey("081113") === csiDedupeKey("08 11 13") === "081113", so the incoming "081113" is
    // recognized as a duplicate of the existing "08 11 13" and DROPPED (first-wins — the existing row
    // keeps its raw form untouched). Only the genuinely new "23 05 00" is added (division derived from
    // code.substring(0,2), trade ""). The format-variant double-write BUG this test used to pin is
    // fixed at its source (csi-utils.ts). (Pre-fix this asserted a third "081113" duplicate row.)
    expect(st.csi).toEqual([
      { code: "08 11 13", description: "existing door", division: "08", trade: "" }, // first-wins, untouched
      { code: "23 05 00", description: "new hvac", division: "23 00 00", trade: "" }, // new code; [csi-v2 S6] division "NN 00 00" (was "23")
    ]);
  });
});
