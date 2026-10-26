// @vitest-environment node
// [refactor jul23 P4.1 U1] Direct nets for log-mode shape observation at the single-create
// sink (observeAnnotationData wired into createAnnotationSingle).
//
// U1's landed contract (spec Verdict 2 + RD-D/RD-E):
//   • v-ABSENT data (every existing wire): the write NEVER changes behavior — valid or
//     malformed, it persists byte-identical (the d120d42 freeze pins this); malformed
//     OBSERVED shapes additionally emit exactly one structured "[shape-registry]" warn.
//   • v-CARRYING data (synthetic here — NO current writer stamps v, RD-E): must classify
//     to a registered shape and pass its schema, else 400 VALIDATION and nothing persists.
//   • U1 observes ONLY scale-calibration (the allowlist grows one frozen unit at a time).
//
// Mutation probes for this net (run at commit, restore from cp backups — never
// `git checkout --`):
//   (a) loosen zScaleCalibrationData to accept-anything  → "malformed persists + warns"
//       and "v:1 invalid → 400" go RED (gate stops rejecting/logging);
//   (b) over-tighten a field (e.g. realDistance .int())  → "valid persists with zero
//       warns" and "v:1 valid persists" go RED (gate over-rejects legit saves);
//   (c) unwire the observeAnnotationData call            → warn-count tests go RED.
import { describe, expect, inject, it, vi, afterEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/annotations/route";
// [refactor jul23 P4.1 U6] PUT route for the update-sink nets (vi.mock is hoisted above).
import { PUT } from "@/app/api/annotations/[id]/route";
// [U6-hazard net] direct-DB plant of a legacy blob (simulating the historic corpus,
// which never passed through the v-gate).
import { db } from "@/lib/db";
import { annotations as annotationsTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  annotationsFor,
  asUser,
  createWorld,
  makeReq,
  params,
  readJson,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const bbox = [0.1, 0.1, 0.3, 0.3];

const postAnnotations = async (body: unknown) =>
  readJson(await POST(makeReq("/api/annotations", { body })));

/** Only the observation module's entries — logger.warn is shared by many subsystems. */
const shapeRegistryWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).startsWith("[shape-registry]"),
  );

const VALID_CALIBRATION = {
  type: "scale-calibration",
  point1: { x: 0.2, y: 0.3 },
  point2: { x: 0.7, y: 0.3 },
  realDistance: 10,
  unit: "ft",
};

const postCalibration = (projectPublicId: string, data: unknown, note: string | null = null) =>
  postAnnotations({
    projectId: projectPublicId,
    pageNumber: 3,
    name: "Scale (pg 3)",
    bbox,
    note,
    source: "takeoff-scale",
    data,
  });

describe.skipIf(!dbUp)("[P4.1 U1] observeAnnotationData at createAnnotationSingle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("valid scale-calibration persists verbatim with ZERO shape-registry warns", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await postCalibration(project.publicId, VALID_CALIBRATION);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(VALID_CALIBRATION);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("MALFORMED scale-calibration STILL persists byte-identical (log-only, zero behavior change) and emits exactly ONE structured warn", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const malformed = {
      ...VALID_CALIBRATION,
      unit: "yards", // not in AreaUnit enum
      realDistance: -5, // violates .positive()
    };
    const { status } = await postCalibration(project.publicId, malformed);
    expect(status).toBe(200); // ← the Verdict-2 contract: log-mode never rejects v0 writes
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(malformed); // persisted unchanged, violations and all
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.create");
    expect(ctx.kind).toBe("scale-calibration");
    expect(ctx.issueCount).toBe(2);
    // Paths+codes only — never blob values (log hygiene).
    expect(ctx.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("unit:"), expect.stringContaining("realDistance:")]),
    );
    expect(JSON.stringify(ctx)).not.toContain("yards");
  });

  // [refactor jul23 P4.1 U2-U4, repointed at U5 and FINAL at U7] With U7 all EIGHT
  // recognized shapes are observed — the permanent non-observed exemplar is an
  // UNKNOWN-kind blob (arbitrary/legacy shape): deliberately unobserved FOREVER (the
  // canary only watches recognized shapes; unknown blobs are the passthrough corpus).
  // This test pins the "unobserved kind persists silently, zero warns" contract leg.
  it("arbitrary UNKNOWN-kind blob persists silently — unknown is never observed (permanent)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const legacyBlob = { legacyKey: "legacy-value", weird: { nested: [1, 2] }, count: "three" };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "legacy",
      bbox,
      note: null,
      data: legacyBlob,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(legacyBlob);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("observation runs on the POST-mergeAutoCsi value: note-triggered calibration gains csiCodes and stays warn-free (zCsiExtension tolerance)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await postCalibration(
      project.publicId,
      VALID_CALIBRATION,
      "Provide cast in place concrete for all foundation walls and footings.",
    );
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    const persisted = row.data as Record<string, unknown>;
    expect(Array.isArray(persisted.csiCodes)).toBe(true); // mergeAutoCsi added codes
    expect((persisted.csiCodes as string[]).length).toBeGreaterThan(0);
    expect(shapeRegistryWarns(warn)).toHaveLength(0); // csiCodes is a tolerated extension, not drift
  });

  it("synthetic v:1 VALID scale-calibration persists (v rides in the blob)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const versioned = { ...VALID_CALIBRATION, v: 1 };
    const { status } = await postCalibration(project.publicId, versioned);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(versioned);
  });

  it("synthetic v:1 INVALID scale-calibration → 400 VALIDATION, NOTHING persisted (the v-gate reject leg)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await postCalibration(project.publicId, {
      ...VALID_CALIBRATION,
      v: 1,
      unit: "yards",
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });

  it("v-carrying but UNCLASSIFIABLE blob → 400 (v implies a registered shape)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "versioned-mystery",
      bbox,
      note: null,
      data: { v: 1, mysteryKey: "no registered shape has this signature" },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });

  it("v:2 (unknown version) on a valid calibration → 400 (schema pins v to literal 1)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status } = await postCalibration(project.publicId, {
      ...VALID_CALIBRATION,
      v: 2,
    });
    expect(status).toBe(400);
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });
});

// [refactor jul23 P4.1 U2-U4] ──────────────────────────────────────────────────
// The three remaining client takeoff shapes join OBSERVED_SHAPES via the SAME
// single-sink mechanism proven in U1 (observeAnnotationData at createAnnotationSingle).
// Each describe block below mirrors the U1 scale-calibration block exactly:
//   (a) valid writer-literal fixture persists verbatim, ZERO shape-registry warns;
//   (b) malformed variant STILL persists byte-identical (log-only — v0 never rejects,
//       the Verdict-2 contract) and emits exactly ONE structured warn carrying
//       sink/kind/issueCount/issues (paths+codes only, no blob values leaked);
//   (c) synthetic v:1 valid persists (v rides in the blob — no current writer stamps v);
//   (d) synthetic v:1 invalid → 400 VALIDATION, nothing persisted (the v-gate reject leg).
// Fixtures are field-for-field from U0_RECON_RAW_2026-07-23.json .result.clientBlobs1;
// production source is "takeoff" at all three writer sites (takeoffCount.ts:100,
// AnnotationOverlay.tsx:664/746/842).
//
// Per-shape mutation probes (run at commit, restore from cp backups — never
// `git checkout --`):
//   • loosen the shape schema to accept-anything → each shape's (b) and (d) go RED
//     (the gate stops logging/rejecting);
//   • over-tighten a field → each shape's (a) and (c) go RED (gate over-rejects
//     legit saves);
//   • unwire the observeAnnotationData call → every (b) warn-count assertion goes RED.

// ── U2: count-marker ─────────────────────────────────────────────────────────
const postCountMarker = (projectPublicId: string, data: unknown) =>
  postAnnotations({
    projectId: projectPublicId,
    pageNumber: 1,
    name: "Count marker (pg 1)",
    bbox,
    note: null,
    source: "takeoff",
    data,
  });

// clientBlobs1 count-marker: type/shape/color/takeoffItemId (all required, no drift).
const VALID_COUNT_MARKER = {
  type: "count-marker",
  shape: "circle", // TakeoffShape enum member (activeItem.shape, guard-narrowed)
  color: "#ff8800", // activeItem.color (string ≤20)
  takeoffItemId: 42, // ClientTakeoffItem.id (positive int)
};

describe.skipIf(!dbUp)("[P4.1 U2] observeAnnotationData — count-marker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("valid count-marker persists verbatim with ZERO shape-registry warns", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await postCountMarker(project.publicId, VALID_COUNT_MARKER);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(VALID_COUNT_MARKER);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("MALFORMED count-marker STILL persists byte-identical (log-only, zero behavior change) and emits exactly ONE structured warn", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const malformed = {
      ...VALID_COUNT_MARKER,
      shape: "hexagon", // not a TakeoffShape enum member
      color: 7, // not a string
    };
    const { status } = await postCountMarker(project.publicId, malformed);
    expect(status).toBe(200); // ← Verdict-2: log-mode never rejects v0 writes
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(malformed); // persisted unchanged, violations and all
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.create");
    expect(ctx.kind).toBe("count-marker");
    expect(ctx.issueCount).toBe(2);
    expect(ctx.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("shape:"), expect.stringContaining("color:")]),
    );
    expect(JSON.stringify(ctx)).not.toContain("hexagon"); // paths+codes only, no values
  });

  it("synthetic v:1 VALID count-marker persists (v rides in the blob)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const versioned = { ...VALID_COUNT_MARKER, v: 1 };
    const { status } = await postCountMarker(project.publicId, versioned);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(versioned);
  });

  it("synthetic v:1 INVALID count-marker → 400 VALIDATION, NOTHING persisted (the v-gate reject leg)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await postCountMarker(project.publicId, {
      ...VALID_COUNT_MARKER,
      v: 1,
      shape: "hexagon",
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });
});

// ── U3: linear-polyline ──────────────────────────────────────────────────────
const postLinear = (projectPublicId: string, data: unknown) =>
  postAnnotations({
    projectId: projectPublicId,
    pageNumber: 2,
    name: "Linear (pg 2)",
    bbox,
    note: null,
    source: "takeoff",
    data,
  });

// clientBlobs1 linear-polyline: type/takeoffItemId/color/vertices(min2)/totalLength/
// unit(plain string — the LINEAR unit ft, NOT the squared AreaUnitSq)/segmentLengths.
const VALID_LINEAR = {
  type: "linear-polyline",
  takeoffItemId: 7,
  color: "#00aa88",
  vertices: [
    { x: 0.1, y: 0.2 },
    { x: 0.4, y: 0.5 },
    { x: 0.6, y: 0.55 },
  ],
  totalLength: 12.5,
  unit: "ft", // cal?.unit || "ft"; LinearPolylineData.unit is plain string
  segmentLengths: [5, 7.5],
};

describe.skipIf(!dbUp)("[P4.1 U3] observeAnnotationData — linear-polyline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("valid linear-polyline persists verbatim with ZERO shape-registry warns", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await postLinear(project.publicId, VALID_LINEAR);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(VALID_LINEAR);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("MALFORMED linear-polyline STILL persists byte-identical (log-only, zero behavior change) and emits exactly ONE structured warn", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const malformed = {
      ...VALID_LINEAR,
      color: "this-color-string-is-way-too-long", // >20 chars, violates zColor.max(20)
      totalLength: -3, // violates .nonnegative()
    };
    const { status } = await postLinear(project.publicId, malformed);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(malformed);
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.create");
    expect(ctx.kind).toBe("linear-polyline");
    expect(ctx.issueCount).toBe(2);
    expect(ctx.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("color:"),
        expect.stringContaining("totalLength:"),
      ]),
    );
    expect(JSON.stringify(ctx)).not.toContain("this-color-string-is-way-too-long");
  });

  it("synthetic v:1 VALID linear-polyline persists (v rides in the blob)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const versioned = { ...VALID_LINEAR, v: 1 };
    const { status } = await postLinear(project.publicId, versioned);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(versioned);
  });

  it("synthetic v:1 INVALID linear-polyline → 400 VALIDATION, NOTHING persisted (the v-gate reject leg)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await postLinear(project.publicId, {
      ...VALID_LINEAR,
      v: 1,
      totalLength: -3, // violates .nonnegative()
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });
});

// ── U4: area-polygon (deep shape — WITH holes) ───────────────────────────────
const postArea = (projectPublicId: string, data: unknown) =>
  postAnnotations({
    projectId: projectPublicId,
    pageNumber: 1,
    name: "Area (pg 1)",
    bbox,
    note: null,
    source: "takeoff",
    data,
  });

// clientBlobs1 area-polygon: type/takeoffItemId/color/vertices(min3)/holes?/areaSqUnits/
// unit(AreaUnitSq — squared SF/SI/SM/SC). The valid fixture is DEEP: it carries the
// optional `holes` array (each hole an object with its own vertices.min(3)), exercising
// the nested loose-object schema, not just the flat top level.
const VALID_AREA = {
  type: "area-polygon",
  takeoffItemId: 3,
  color: "#3366cc",
  vertices: [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.5 },
  ],
  holes: [
    {
      vertices: [
        { x: 0.2, y: 0.2 },
        { x: 0.35, y: 0.2 },
        { x: 0.35, y: 0.35 },
      ],
    },
  ],
  areaSqUnits: 250.5,
  unit: "SF", // AreaUnitSq (squared) — contrast the linear "ft" above
};

describe.skipIf(!dbUp)("[P4.1 U4] observeAnnotationData — area-polygon (deep: holes)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("valid area-polygon (WITH holes) persists verbatim with ZERO shape-registry warns", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await postArea(project.publicId, VALID_AREA);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(VALID_AREA); // holes and all, deep-equal
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("MALFORMED area-polygon STILL persists byte-identical (log-only) and emits ONE warn with TWO distinct issue paths (bad unit AND <3 vertices)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const malformed = {
      ...VALID_AREA,
      unit: "acres", // not an AreaUnitSq enum member (field-value violation)
      vertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ], // only 2 points — violates vertices.min(3)
    };
    const { status } = await postArea(project.publicId, malformed);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(malformed);
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.create");
    expect(ctx.kind).toBe("area-polygon");
    expect(ctx.issueCount).toBe(2); // TWO distinct paths
    expect(ctx.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unit:"),
        expect.stringContaining("vertices:"),
      ]),
    );
    expect(JSON.stringify(ctx)).not.toContain("acres");
  });

  it("synthetic v:1 VALID area-polygon (with holes) persists (v rides in the blob)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const versioned = { ...VALID_AREA, v: 1 };
    const { status } = await postArea(project.publicId, versioned);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(versioned);
  });

  it("synthetic v:1 INVALID area-polygon → 400 VALIDATION, NOTHING persisted (the v-gate reject leg)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await postArea(project.publicId, {
      ...VALID_AREA,
      v: 1,
      unit: "acres", // not an AreaUnitSq enum member
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });
});

// ── U5: symbol-search + the BATCH sink (createAnnotationBatch) ───────────────
// [refactor jul23 P4.1 U5] First unit observing the batch sink. Rows are merged +
// observed BEFORE the tx (annotations.ts): a v-carrying invalid item must 400 the
// WHOLE batch BEFORE the delete-before-insert runs — the atomicity pin below proves
// a rejected batch never leaves a source's annotations deleted-but-not-replaced.
// clientBlobs2U1 symbol-search: modelName/method/confidence/scale/templateSourcePage?.
const VALID_SYMBOL = {
  modelName: "symbol-search",
  method: "ncc",
  confidence: 0.83,
  scale: 1,
  templateSourcePage: 2,
};

const postSymbolBatch = (
  projectPublicId: string,
  data: unknown,
  extras: Record<string, unknown> = {},
) =>
  postAnnotations({
    projectId: projectPublicId,
    ...extras,
    annotations: [
      {
        pageNumber: 4,
        name: "symbol-match",
        bbox,
        source: "symbol-search",
        threshold: 0.83,
        note: null,
        data,
      },
    ],
  });

describe.skipIf(!dbUp)("[P4.1 U5] observeAnnotationData — symbol-search at the batch sink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("valid symbol-search batch persists verbatim with ZERO shape-registry warns", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status, body } = await postSymbolBatch(project.publicId, VALID_SYMBOL);
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(VALID_SYMBOL);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("MALFORMED symbol-search batch STILL persists byte-identical and emits exactly ONE warn with sink=annotations.createBatch", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const malformed = { ...VALID_SYMBOL, method: 5, confidence: "high" };
    const { status } = await postSymbolBatch(project.publicId, malformed);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(malformed);
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.createBatch");
    expect(ctx.kind).toBe("symbol-search");
    expect(ctx.failedCount).toBe(1); // [U5-review] aggregated ctx carries per-batch counts
    expect(ctx.issueCount).toBe(2);
    expect(ctx.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("method:"), expect.stringContaining("confidence:")]),
    );
    // Paths+codes only — never blob values (parity with the U1-U4 leak guards).
    expect(JSON.stringify(ctx)).not.toContain("high");
  });

  it("[U5-review] multi-row drift aggregates to ONE warn per (sink, kind) — not one per row", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const malformed = { ...VALID_SYMBOL, method: 5 };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      annotations: [
        { pageNumber: 4, name: "m1", bbox, source: "symbol-search", note: null, data: malformed },
        { pageNumber: 4, name: "m2", bbox, source: "symbol-search", note: null, data: malformed },
        { pageNumber: 4, name: "ok", bbox, source: "symbol-search", note: null, data: VALID_SYMBOL },
      ],
    });
    expect(status).toBe(200); // log-only: all three rows persist
    expect(await annotationsFor(project.id)).toHaveLength(3);
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1); // ← the aggregation contract: one warn, not two
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.rowCount).toBe(3);
    expect(ctx.failedCount).toBe(2);
    expect(ctx.issues).toEqual(expect.arrayContaining([expect.stringContaining("method:")]));
  });

  it("synthetic v:1 VALID symbol-search batch persists", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const versioned = { ...VALID_SYMBOL, v: 1 };
    const { status } = await postSymbolBatch(project.publicId, versioned);
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(versioned);
  });

  it("v:1 INVALID item 400s the WHOLE batch BEFORE delete-before-insert — seeded rows survive (atomicity pin)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    // Seed an existing symbol-search row on page 4 (plain append).
    const seeded = await postSymbolBatch(project.publicId, VALID_SYMBOL);
    // Rejected batch that WOULD have deleted page 4's symbol-search rows first.
    const { status, body } = await postSymbolBatch(
      project.publicId,
      { ...VALID_SYMBOL, v: 1, method: 5 },
      // [TP-1 WP-1.C fix, K12] symbol-search replaces by id (deletePageNumbers is refused for it).
      { deleteSource: "symbol-search", deleteIds: [seeded.body.annotations[0].id] },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    // The seeded row is STILL THERE. [U5-review note] This pins the SAFETY OUTCOME (a
    // rejected batch never leaves a source deleted-but-not-replaced); the wiring places
    // the gate pre-tx, but an in-tx-post-delete throw would also roll back to this same
    // state — the invariant, not the mechanism, is what this net freezes.
    const rows = await annotationsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual(VALID_SYMBOL);
  });
});

// ── U6: empty-markup + the PUT sink (annotations.update) ─────────────────────
// [refactor jul23 P4.1 U6] The PUT writes the data column in two ways (both frozen in
// d120d42): body.data whole-blob replace, and the note-only auto-csi seed of the
// EXISTING row's blob. Observation runs on the FINAL updates.data value, post-seed,
// pre-tx, only when the column will actually be written. empty-markup joins the
// allowlist (all-optional schema — only wrong-typed known keys can warn).
describe.skipIf(!dbUp)("[P4.1 U6] observeAnnotationData — PUT sink + empty-markup", () => {
  afterEach(() => vi.restoreAllMocks());

  const putAnnotation = async (id: number, body: unknown) =>
    readJson(
      await PUT(
        makeReq(`/api/annotations/${id}`, { method: "PUT", body }),
        params({ id: String(id) }),
      ),
    );
  const seed = async (projectPublicId: string, data: Record<string, unknown>) => {
    const { body } = await postAnnotations({
      projectId: projectPublicId,
      pageNumber: 1,
      name: "u6-seed",
      bbox,
      note: null,
      data,
    });
    return body.id as number;
  };

  it("malformed empty-markup (wrong-typed csiCodes) at the CREATE sink warns with kind=empty-markup", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const bad = { csiCodes: "not-an-array" };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "markup-bad",
      bbox,
      note: null,
      data: bad,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(bad); // log-only: persists unchanged
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as Record<string, unknown>).kind).toBe("empty-markup");
  });

  it("PUT body.data replace with a malformed observed shape persists + warns with sink=annotations.update", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, { type: "count-marker", shape: "circle", color: "#111", takeoffItemId: 1 });
    const warn = vi.spyOn(logger, "warn");
    const malformed = { type: "count-marker", shape: "hexagon", color: "#222", takeoffItemId: 2 };
    const { status } = await putAnnotation(id, { data: malformed });
    expect(status).toBe(200); // log-only: v0 PUT never rejects
    const rows = await annotationsFor(project.id);
    expect(rows[0].data).toEqual(malformed); // whole-blob replace, violations and all
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.update");
    expect(ctx.kind).toBe("count-marker");
    expect(JSON.stringify(ctx)).not.toContain("hexagon");
  });

  it("PUT note-only auto-csi seed observes the SEEDED value without a false positive", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, { type: "count-marker", shape: "circle", color: "#333", takeoffItemId: 3 });
    const warn = vi.spyOn(logger, "warn");
    const { status } = await putAnnotation(id, {
      note: "Provide cast in place concrete for all foundation walls and footings.",
    });
    expect(status).toBe(200);
    const rows = await annotationsFor(project.id);
    const persisted = rows[0].data as Record<string, unknown>;
    expect(Array.isArray(persisted.csiCodes)).toBe(true); // seed happened
    expect(shapeRegistryWarns(warn)).toHaveLength(0); // csiCodes extension tolerated
  });

  // [P4.1 tranche-review] The seed-path POSITIVE warn net (U6-review LOW residual): the
  // note-only branch's observation must actually SURFACE drift, not just stay silent on
  // valid seeds. Existing blob is a malformed OBSERVED shape; the auto-csi seed re-persists
  // it → exactly one warn. An unwired seed-branch observe would leave this at zero warns.
  it("note-only PUT over a MALFORMED existing observed blob warns once at sink=annotations.update (seed-path positive proof)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, {
      type: "count-marker",
      shape: "hexagon", // not a TakeoffShape — the planted drift
      color: "#abc",
      takeoffItemId: 9,
    });
    const warn = vi.spyOn(logger, "warn");
    const { status } = await putAnnotation(id, {
      note: "Provide cast in place concrete for all foundation walls and footings.",
    });
    expect(status).toBe(200); // log-only: the seeded write still succeeds
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("annotations.update");
    expect(ctx.kind).toBe("count-marker");
  });

  it("PUT name-only (no data write) performs NO observation", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, { csiCodes: "not-an-array" }); // malformed markup already in row
    const warn = vi.spyOn(logger, "warn");
    const { status } = await putAnnotation(id, { name: "renamed" });
    expect(status).toBe(200);
    expect(shapeRegistryWarns(warn)).toHaveLength(0); // data column untouched → unobserved
  });

  it("PUT v:1 VALID data persists through the update sink", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, { type: "count-marker", shape: "circle", color: "#444", takeoffItemId: 4 });
    const versioned = { type: "count-marker", shape: "square", color: "#555", takeoffItemId: 5, v: 1 };
    const { status } = await putAnnotation(id, { data: versioned });
    expect(status).toBe(200);
    const rows = await annotationsFor(project.id);
    expect(rows[0].data).toEqual(versioned);
  });

  it("PUT v:1 INVALID data → 400 and the EXISTING blob is untouched (update-sink reject pin)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const original = { type: "count-marker", shape: "circle", color: "#666", takeoffItemId: 6 };
    const id = await seed(project.publicId, original);
    const { status, body } = await putAnnotation(id, {
      data: { type: "count-marker", shape: "hexagon", color: "#777", takeoffItemId: 7, v: 1 },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    const rows = await annotationsFor(project.id);
    expect(rows[0].data).toEqual(original); // nothing written
  });

  // [U6-hazard] The historic corpus never passed through the v-gate; a legacy blob may
  // carry a coincidental top-level `v` key. A note-only PUT re-persists the row's OWN
  // blob (auto-csi seed) — an EXISTING wire, which must NEVER 400 (Verdict 2). The gate
  // arms only for client-supplied body.data.
  it("note-only PUT on a legacy row with a coincidental v key STILL succeeds (seed path never gated)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await seed(project.publicId, { foo: "legacy" });
    // Plant the coincidental v key directly (simulates pre-registry historic data).
    const legacyBlob = { foo: "legacy", v: "0.9-beta" };
    await db
      .update(annotationsTable)
      .set({ data: legacyBlob })
      .where(eq(annotationsTable.id, id));
    const { status } = await putAnnotation(id, {
      note: "Provide cast in place concrete for all foundation walls and footings.",
    });
    expect(status).toBe(200); // ← the wire survives; a gated seed path would 400 here
    const rows = await annotationsFor(project.id);
    const persisted = rows[0].data as Record<string, unknown>;
    expect(persisted.foo).toBe("legacy"); // legacy keys intact
    expect(persisted.v).toBe("0.9-beta"); // coincidental v preserved verbatim
    expect(Array.isArray(persisted.csiCodes)).toBe(true); // the seed still happened
  });
});
