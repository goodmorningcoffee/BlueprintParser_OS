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

  it("malformed NON-observed shape (count-marker) persists silently — U1 allowlist is scale-calibration only", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const badMarker = { type: "count-marker", shape: "hexagon", color: 7, takeoffItemId: "x" };
    const { status } = await postAnnotations({
      projectId: project.publicId,
      pageNumber: 1,
      name: "marker",
      bbox,
      note: null,
      data: badMarker,
    });
    expect(status).toBe(200);
    const [row] = await annotationsFor(project.id);
    expect(row.data).toEqual(badMarker);
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
