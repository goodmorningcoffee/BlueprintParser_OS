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
import { logger } from "@/lib/logger";
import {
  annotationsFor,
  asUser,
  createWorld,
  makeReq,
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

  // [refactor jul23 P4.1 U2-U4] Repointed from count-marker → symbol-search. U2-U4 add
  // count-marker/linear-polyline/area-polygon to OBSERVED_SHAPES, so a malformed
  // count-marker now WARNS (covered by the U2 describe block below). symbol-search is the
  // still-unobserved exemplar (it joins the allowlist at U5), so it keeps proving the
  // "non-observed shape persists silently, zero warns" leg of the contract.
  it("malformed NON-observed shape (symbol-search) persists silently — U2-U4 allowlist stops before symbol-search (U5)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const badSymbol = { modelName: "symbol-search", method: 5, confidence: "high", scale: -1 };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "symbol",
      bbox,
      note: null,
      data: badSymbol,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(badSymbol);
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
