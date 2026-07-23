// [refactor jul23 P4.1 U0] Direct unit nets for the shape registry.
//
// Schemas-only, NO DB; runs in the default jsdom environment (no environment
// pragma — spelling the pragma token out in a leading comment makes vitest
// parse the next word as an environment name). Covers:
//  (a) every writer-literal fixture parses green through its shape schema AND the union
//  (b) .loose() preservation: an unknown sentinel key survives .parse() output
//  (c) per-field reject arms (the mutation-probe hooks — flip a schema and one goes green)
//  (d) classifier: fixtures classify to their shape; {} → empty-markup; legacy → unknown; never throws
//  (e) compile-time Expect<Extends<z.infer, HandWrittenType>> against the AUTHORITATIVE types/index.ts
//  (f) v:1 accepted, v:2 rejected on every shape
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  // annotation shape schemas
  zYoloDetectionData,
  zShapeParseData,
  zSymbolSearchData,
  zCountMarkerData,
  zAreaPolygonData,
  zLinearPolylineData,
  zScaleCalibrationData,
  zEmptyMarkupData,
  zAnnotationData,
  zRecognizedAnnotationData,
  classifyAnnotationData,
  SHAPE_SCHEMAS,
  type AnnotationDataKind,
  // csi schemas
  zCsiCode,
  zCsiCodeTrigger,
  // region schemas
  zGridRegionData,
  zSpecRegionData,
  zKeynoteRegionData,
  zLegendRegionData,
  zNotesLegacyRegionData,
  zRegionData,
  classifyRegionData,
  // primitive enums
  zAreaUnit,
  zAreaUnitSq,
  zTakeoffShape,
} from "@/types/shapes";
import type {
  CountMarkerData as HandCountMarkerData,
  ScaleCalibrationData as HandScaleCalibrationData,
  AreaPolygonData as HandAreaPolygonData,
  LinearPolylineData as HandLinearPolylineData,
  CsiCode as HandCsiCode,
  CsiCodeTrigger as HandCsiCodeTrigger,
  AreaUnit as HandAreaUnit,
  AreaUnitSq as HandAreaUnitSq,
  TakeoffShape as HandTakeoffShape,
} from "@/types";

// ─── (e) compile-time type guards ────────────────────────────
// These type aliases fail `tsc --noEmit` if the schema drifts from the
// AUTHORITATIVE hand-written types (RD-B: hand-written stays source of truth).
type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// z.infer of each closed shape must be assignable to its hand-written type.
type _e_count = Expect<Extends<z.infer<typeof zCountMarkerData>, HandCountMarkerData>>;
type _e_scale = Expect<
  Extends<z.infer<typeof zScaleCalibrationData>, HandScaleCalibrationData>
>;
type _e_area = Expect<Extends<z.infer<typeof zAreaPolygonData>, HandAreaPolygonData>>;
type _e_linear = Expect<
  Extends<z.infer<typeof zLinearPolylineData>, HandLinearPolylineData>
>;
type _e_csi = Expect<Extends<z.infer<typeof zCsiCode>, HandCsiCode>>;
type _e_trig = Expect<Extends<z.infer<typeof zCsiCodeTrigger>, HandCsiCodeTrigger>>;

// Type-only unions (no runtime const) get an exact Equal guard.
type _q_areaUnit = Expect<Equal<z.infer<typeof zAreaUnit>, HandAreaUnit>>;
type _q_areaUnitSq = Expect<Equal<z.infer<typeof zAreaUnitSq>, HandAreaUnitSq>>;
type _q_takeoff = Expect<Equal<z.infer<typeof zTakeoffShape>, HandTakeoffShape>>;

// Silence any "declared but never used" tooling without changing semantics.
export type __ShapesTypeGuards = [
  _e_count,
  _e_scale,
  _e_area,
  _e_linear,
  _e_csi,
  _e_trig,
  _q_areaUnit,
  _q_areaUnitSq,
  _q_takeoff,
];

// ─── writer-literal fixtures (from recon U0_RECON_RAW) ───────
// Each is a byte-shape copy of what the verified writer site emits.
const fixtures: Record<
  Exclude<AnnotationDataKind, "unknown">,
  Record<string, unknown>
> = {
  // yolo.ts:583-590 — all 6 fields always present at write
  "yolo-detection": {
    modelId: 7,
    modelName: "yolo-doors-v8",
    classId: 3,
    confidence: 0.87,
    csiCodes: ["08 11 13"],
    keywords: ["door"],
  },
  // processing.ts:504 / DetectionPanel.tsx:951 — contour defaulted [] server-side
  "shape-parse": {
    modelName: "shape-parse",
    shapeType: "circle",
    text: "A1",
    contour: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    confidence: 0.9,
  },
  // SymbolSearchPanel.tsx:837-843
  "symbol-search": {
    modelName: "symbol-search",
    method: "template-ncc",
    confidence: 0.75,
    scale: 1,
    templateSourcePage: 2,
  },
  // takeoffCount.ts:87-92
  "count-marker": {
    type: "count-marker",
    shape: "circle",
    color: "#ff0000",
    takeoffItemId: 42,
  },
  // AnnotationOverlay.tsx:729-736 bucket-fill variant (holes present)
  "area-polygon": {
    type: "area-polygon",
    takeoffItemId: 7,
    color: "#00ff00",
    vertices: [
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.1 },
      { x: 0.25, y: 0.4 },
    ],
    holes: [
      {
        vertices: [
          { x: 0.2, y: 0.2 },
          { x: 0.3, y: 0.2 },
          { x: 0.25, y: 0.3 },
        ],
      },
    ],
    areaSqUnits: 12.5,
    unit: "SF",
  },
  // AnnotationOverlay.tsx:827-835
  "linear-polyline": {
    type: "linear-polyline",
    takeoffItemId: 9,
    color: "#0000ff",
    vertices: [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ],
    totalLength: 10.2,
    unit: "ft",
    segmentLengths: [10.2],
  },
  // CalibrationInput.tsx:65-71 (U1 target)
  "scale-calibration": {
    type: "scale-calibration",
    point1: { x: 0.1, y: 0.1 },
    point2: { x: 0.9, y: 0.1 },
    realDistance: 12,
    unit: "ft",
  },
  // llm/tools.ts:578 — literal {}
  "empty-markup": {},
};

const shapeKinds = Object.keys(fixtures) as Array<
  Exclude<AnnotationDataKind, "unknown">
>;

// ─── (a) writer literals parse green (shape schema + union) ──
describe("annotation shapes — (a) writer-literal fixtures parse green", () => {
  for (const kind of shapeKinds) {
    it(`${kind} parses via its shape schema`, () => {
      const r = SHAPE_SCHEMAS[kind].safeParse(fixtures[kind]);
      expect(r.success).toBe(true);
    });
    it(`${kind} parses via the recognized union`, () => {
      expect(zRecognizedAnnotationData.safeParse(fixtures[kind]).success).toBe(true);
    });
    it(`${kind} parses via the full union`, () => {
      expect(zAnnotationData.safeParse(fixtures[kind]).success).toBe(true);
    });
  }

  it("a legacy/arbitrary blob still parses via the full union (never throws)", () => {
    const legacy = { foo: "bar", legacyThing: 123, nested: { a: [1, 2] } };
    expect(zAnnotationData.safeParse(legacy).success).toBe(true);
  });
});

// ─── (b) .loose() preservation — sentinel round-trip ─────────
describe("annotation shapes — (b) .loose() preserves unknown keys byte-identical", () => {
  for (const kind of shapeKinds) {
    it(`${kind} preserves an unknown sentinel key through .parse()`, () => {
      const withSentinel = { ...fixtures[kind], __sentinel: "preserve" };
      const parsed = SHAPE_SCHEMAS[kind].parse(withSentinel) as Record<
        string,
        unknown
      >;
      expect(parsed.__sentinel).toBe("preserve");
      // full byte-shape survival (known + unknown keys), not just the sentinel
      expect(parsed).toEqual(withSentinel);
    });
  }
});

// ─── (c) per-field reject arms (mutation-probe hooks) ────────
// One wrong-typed field per shape must fail safeParse even though schemas are
// .loose() (loose tolerates unknown KEYS, never wrong-typed KNOWN keys).
describe("annotation shapes — (c) reject arms (mutation probes)", () => {
  const rejects: Record<Exclude<AnnotationDataKind, "unknown">, Record<string, unknown>> = {
    "yolo-detection": { ...fixtures["yolo-detection"], classId: -1 }, // nonnegative int
    "shape-parse": { ...fixtures["shape-parse"], confidence: "high" }, // number
    "symbol-search": { ...fixtures["symbol-search"], scale: "x" }, // number
    "count-marker": { ...fixtures["count-marker"], shape: "hexagon" }, // enum
    "area-polygon": { ...fixtures["area-polygon"], unit: "ft" }, // AreaUnitSq only
    "linear-polyline": {
      ...fixtures["linear-polyline"],
      vertices: [{ x: 0.1, y: 0.1 }], // min(2)
    },
    "scale-calibration": { ...fixtures["scale-calibration"], realDistance: -1 }, // positive
    "empty-markup": { csiCodes: [123] }, // csiCodes must be string[]
  };
  for (const kind of shapeKinds) {
    it(`${kind} rejects a wrong-typed field`, () => {
      expect(SHAPE_SCHEMAS[kind].safeParse(rejects[kind]).success).toBe(false);
    });
  }
});

// ─── (d) classifier ──────────────────────────────────────────
describe("annotation classifier — (d)", () => {
  for (const kind of shapeKinds) {
    it(`classifies the ${kind} fixture as "${kind}"`, () => {
      expect(classifyAnnotationData(fixtures[kind])).toBe(kind);
    });
    it(`${kind} classified-kind's schema parses the fixture`, () => {
      const k = classifyAnnotationData(fixtures[kind]);
      expect(SHAPE_SCHEMAS[k].safeParse(fixtures[kind]).success).toBe(true);
    });
  }

  it('classifies {} as "empty-markup"', () => {
    expect(classifyAnnotationData({})).toBe("empty-markup");
  });
  it('classifies a csi-only blob as "empty-markup"', () => {
    expect(classifyAnnotationData({ csiCodes: ["08 11 13"] })).toBe("empty-markup");
  });
  it('classifies an arbitrary legacy blob as "unknown"', () => {
    expect(classifyAnnotationData({ foo: "bar", legacyThing: 1 })).toBe("unknown");
    // a marker key with an unrecognized value is unknown, not empty-markup
    expect(classifyAnnotationData({ type: "legacy-thing" })).toBe("unknown");
  });
  it("never throws on non-object / degenerate inputs", () => {
    for (const bad of [null, undefined, "str", 42, true, [], [1, 2], NaN]) {
      expect(() => classifyAnnotationData(bad)).not.toThrow();
      expect(classifyAnnotationData(bad)).toBe("unknown");
    }
  });
});

// ─── (f) version tag ─────────────────────────────────────────
describe("annotation shapes — (f) v:1 accepted, v:2 rejected", () => {
  for (const kind of shapeKinds) {
    it(`${kind} accepts v:1`, () => {
      expect(SHAPE_SCHEMAS[kind].safeParse({ ...fixtures[kind], v: 1 }).success).toBe(
        true,
      );
    });
    it(`${kind} rejects v:2`, () => {
      expect(SHAPE_SCHEMAS[kind].safeParse({ ...fixtures[kind], v: 2 }).success).toBe(
        false,
      );
    });
  }
});

// ─── region shapes ───────────────────────────────────────────
describe("region shapes — parse green + classify + loose preservation", () => {
  const grid = {
    headers: ["TAG", "TYPE"],
    rows: [{ TAG: "D-01", TYPE: "Hollow Metal" }],
    tagColumn: "TAG",
    tableName: "Door Schedule",
    rowCount: 1,
    columnCount: 2,
    colBoundaries: [0, 0.5, 1],
    rowBoundaries: [0, 0.5, 1],
  };
  const spec = {
    sections: [{ sectionHeader: "PART 1 - GENERAL", body: "..." }],
    tableName: "Spec 08 11 13",
    csiTags: [{ code: "08 11 13", description: "Doors" }],
  };
  const keynote = {
    headers: ["Key", "Note"],
    rows: [{ Key: "1", Note: "typ" }],
    tagColumn: "Key",
    tableName: "Keynotes",
    rowCount: 1,
    columnCount: 2,
    keynotes: [{ key: "1", description: "typ" }],
    isPageSpecific: true,
  };
  const legend = { symbols: [{ yoloClass: "door", description: "Door symbol" }] };
  const notesLegacy = {
    title: "General Notes",
    notes: ["Note one", "Note two"],
    isBoilerplate: [false, true],
  };

  it("grid parses + classifies grid", () => {
    expect(zGridRegionData.safeParse(grid).success).toBe(true);
    expect(zRegionData.safeParse(grid).success).toBe(true);
    expect(classifyRegionData(grid)).toBe("grid");
  });
  it("spec parses + classifies spec", () => {
    expect(zSpecRegionData.safeParse(spec).success).toBe(true);
    expect(zRegionData.safeParse(spec).success).toBe(true);
    expect(classifyRegionData(spec)).toBe("spec");
  });
  it("keynote (hybrid grid+keynotes) parses + classifies keynote", () => {
    expect(zKeynoteRegionData.safeParse(keynote).success).toBe(true);
    expect(zRegionData.safeParse(keynote).success).toBe(true);
    expect(classifyRegionData(keynote)).toBe("keynote");
  });
  it("legend parses + classifies legend", () => {
    expect(zLegendRegionData.safeParse(legend).success).toBe(true);
    expect(classifyRegionData(legend)).toBe("legend");
  });
  it("legacy notes parses + classifies notes-legacy", () => {
    expect(zNotesLegacyRegionData.safeParse(notesLegacy).success).toBe(true);
    expect(classifyRegionData(notesLegacy)).toBe("notes-legacy");
  });
  it("arbitrary blob parses via union (unknown fallback) + classifies unknown", () => {
    const legacy = { weird: true, stuff: [1, 2, 3] };
    expect(zRegionData.safeParse(legacy).success).toBe(true);
    expect(classifyRegionData(legacy)).toBe("unknown");
  });
  it("region classifier never throws on degenerate inputs", () => {
    for (const bad of [null, undefined, "s", 3, []]) {
      expect(() => classifyRegionData(bad)).not.toThrow();
      expect(classifyRegionData(bad)).toBe("unknown");
    }
  });
  it("grid preserves an unknown sentinel key (.loose())", () => {
    const parsed = zGridRegionData.parse({ ...grid, __sentinel: "keep" }) as Record<
      string,
      unknown
    >;
    expect(parsed.__sentinel).toBe("keep");
  });
  it("grid rejects a wrong-typed field (headers must be string[])", () => {
    expect(zGridRegionData.safeParse({ ...grid, headers: [1, 2] }).success).toBe(false);
  });
});

// ─── csi shapes ──────────────────────────────────────────────
describe("csi shapes — CsiCode + trigger", () => {
  const trigger = { text: "door", bbox: [0.1, 0.2, 0.05, 0.03], tier: 1 };
  const code = {
    code: "08 11 13",
    description: "Steel Doors and Frames",
    trade: "08",
    division: "08",
    triggers: [trigger],
  };
  it("CsiCodeTrigger parses green", () =>
    expect(zCsiCodeTrigger.safeParse(trigger).success).toBe(true));
  it("CsiCode (with triggers) parses green", () =>
    expect(zCsiCode.safeParse(code).success).toBe(true));
  it("CsiCode without triggers parses green (legacy/pre-triggers)", () => {
    const { triggers: _drop, ...noTriggers } = code;
    void _drop;
    expect(zCsiCode.safeParse(noTriggers).success).toBe(true);
  });
  it("CsiCode preserves an unknown key (.loose())", () => {
    const parsed = zCsiCode.parse({ ...code, __sentinel: "keep" }) as Record<
      string,
      unknown
    >;
    expect(parsed.__sentinel).toBe("keep");
  });
  it("CsiCodeTrigger rejects a wrong-typed tier", () =>
    expect(zCsiCodeTrigger.safeParse({ ...trigger, tier: 4 }).success).toBe(false));
});
