import { describe, it, expect } from "vitest";
import {
  csiCodeMatchesQuery,
  csiCodesForLlm,
  csiDivisionOf,
  csiTriggerHits,
  mergeCsiCodes,
  normalizeCsiCode,
  normalizeCsiCodes,
} from "@/lib/csi-utils";
import { DEFAULT_CSI_V2_CONFIG } from "@/lib/csi-v2-config";
import type { CsiCode } from "@/types";

describe("mergeCsiCodes", () => {
  it("adds new codes while deduping by code", () => {
    const existing: CsiCode[] = [
      { code: "08", description: "Openings", division: "08", trade: "" },
    ];
    const incoming = [
      { code: "08", description: "Openings (duplicate)" },
      { code: "09", description: "Finishes" },
    ];
    const merged = mergeCsiCodes(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].description).toBe("Openings");
    expect(merged[1].code).toBe("09");
  });

  it("derives division as 'NN 00 00' when not provided [csi-v2 S6; was the bare prefix '08']", () => {
    const merged = mergeCsiCodes([], [
      { code: "08 11 16", description: "Aluminum Doors" },
    ]);
    expect(merged[0].division).toBe("08 00 00");
    expect(merged[0].trade).toBe("");
  });

  it("returns a copy of existing when incoming is empty (no mutation)", () => {
    const existing: CsiCode[] = [
      { code: "03", description: "Concrete", division: "03", trade: "" },
    ];
    const merged = mergeCsiCodes(existing, []);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });
});

// [refactor jul23 P4.1 U9] Characterization of the raw-code dedupe bug and the
// data-loss hazard that constrains the fix. mergeCsiCodes today builds its `seen`
// set from the RAW `.code` string (csi-utils.ts:52,55) and never normalizes, so
// two format-variants of one logical code ("08 11 13" vs "081113") both persist.
// The fix (Stage B) keys dedupe on a separator-strip-only `csiDedupeKey` — which
// collapses format variants BUT must NOT truncate (full normalizeCsiCode would
// collapse distinct Level-4 dotted siblings → silent data loss). These pins mark
// exactly what flips (case 1) and what must SURVIVE unchanged (case 2, case 3).
describe("mergeCsiCodes — raw-code dedupe (PRE-FIX characterization)", () => {
  it("FIXED (U9): format-variants '08 11 13' + '081113' collapse to ONE entry (length 1) — existing raw form kept", () => {
    const merged = mergeCsiCodes(
      [{ code: "08 11 13", description: "existing door", division: "08", trade: "" }],
      [{ code: "081113", description: "raw-form dup" }],
    );
    // Stage B fix: csiDedupeKey("081113") === csiDedupeKey("08 11 13") === "081113",
    // so the incoming variant is recognized as a duplicate and dropped (first-wins).
    // The existing row keeps its raw "08 11 13" form verbatim. (Was length 2 pre-fix.)
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      code: "08 11 13",
      description: "existing door",
      division: "08",
      trade: "",
    });
  });

  it("PIN — must SURVIVE the fix (anti-data-loss guard): Level-4 dotted siblings '00 24 13.13' + '00 24 13.16' BOTH persist (length 2)", () => {
    const merged = mergeCsiCodes(
      [{ code: "00 24 13.13", description: "sibling .13", division: "00", trade: "" }],
      [{ code: "00 24 13.16", description: "sibling .16" }],
    );
    // These are two DIFFERENT real MasterFormat codes (the csi-masterformat TSV corpus). The
    // separator-strip-only key keeps them distinct ("00241313" != "00241316"), so this
    // stays length 2 AFTER the fix. A truncating key would collapse them → data loss.
    expect(merged).toHaveLength(2);
  });

  it("[csi-v2 S6 flip] normalizeCsiCode no longer truncates Level-5 codes: the two dotted siblings stay distinct", () => {
    // Pre-S6 both normalized to "00 24 13" (measured on c6ad951) — the data-loss hazard this
    // block documented. They now keep their ".NN" suffix; dedupe still keys on csiDedupeKey.
    expect(normalizeCsiCode("00 24 13.16")).toBe("00 24 13.16");
    expect(normalizeCsiCode("00 24 13.13")).toBe("00 24 13.13");
  });
});

// [refactor jul23 P4.1 U9] Pre-swap equivalence net for Stage C. The yolo-load path
// (src/server/services/yolo.ts) hand-rolls a placeholder-CSI merge with ZERO test
// coverage. Stage C replaces that loop with mergeCsiCodes. This pins that, for the
// yolo call shape, mergeCsiCodes reproduces the loop's objects byte-for-byte — proving
// the swap is an identity. Inputs are distinct, non-format-variant codes so raw-code
// dedupe (the loop) and csiDedupeKey dedupe (post-Stage-B mergeCsiCodes) AGREE; the
// equivalence therefore holds both before and after the Stage B key change.
describe("yolo placeholder merge — pre-swap equivalence net (Stage C identity)", () => {
  // Faithful replica of the yolo.ts merge loop as it stood before Stage C.
  function yoloLoopMerge(existingPageCsi: CsiCode[], allYoloCsi: string[]): CsiCode[] {
    const existingSet = new Set(existingPageCsi.map((c) => c.code));
    const newCsi: CsiCode[] = [...existingPageCsi];
    for (const code of allYoloCsi) {
      if (!existingSet.has(code)) {
        newCsi.push({
          code,
          description: "From YOLO class config",
          division: code.substring(0, 2),
          trade: "",
        });
      }
    }
    return newCsi;
  }
  // [csi-v2 S6] The ONE sanctioned delta vs the replica: an ADDED code's derived division is
  // "NN 00 00" (the engine's own form), not the bare prefix. Rows from `existing` are untouched.
  const withS6Division = (rows: CsiCode[], keptCount: number): CsiCode[] =>
    rows.map((c, i) => (i < keptCount ? c : { ...c, division: `${c.code.substring(0, 2)} 00 00` }));

  it("reproduces the loop's objects byte-for-byte (empty existing)", () => {
    const existing: CsiCode[] = [];
    const yoloCodes = ["08 11 00", "23 05 00"];
    const viaMerge = mergeCsiCodes(
      existing,
      yoloCodes.map((code) => ({ code, description: "From YOLO class config" })),
    );
    expect(viaMerge).toEqual(withS6Division(yoloLoopMerge(existing, yoloCodes), existing.length));
  });

  // [P4.1 tranche-review] The variant-collapse delta on the yolo path IS the U9 fix
  // propagating (review-adjudicated desired): a format-variant of an existing page code
  // no longer grows the array, so yolo.ts's `newCsi.length > existing.length` write-guard
  // SKIPS the write instead of persisting a duplicate. Pinned here at the merge level.
  it("format-variant yolo code collapses into the existing entry — length unchanged, so the yolo write-guard skips", () => {
    const existing: CsiCode[] = [
      { code: "08 11 13", description: "existing door", division: "08", trade: "" },
    ];
    const viaMerge = mergeCsiCodes(
      existing,
      ["081113"].map((code) => ({ code, description: "From YOLO class config" })),
    );
    expect(viaMerge).toHaveLength(existing.length); // guard condition false → no page write
    expect(viaMerge[0].code).toBe("08 11 13"); // raw existing form kept
  });

  it("reproduces the loop's objects byte-for-byte (existing present; already-present code skipped by both)", () => {
    const existing: CsiCode[] = [
      { code: "03 30 00", description: "Concrete", division: "03", trade: "" },
    ];
    const yoloCodes = ["08 11 00", "03 30 00"]; // "03 30 00" already present → both skip it
    const viaMerge = mergeCsiCodes(
      existing,
      yoloCodes.map((code) => ({ code, description: "From YOLO class config" })),
    );
    expect(viaMerge).toEqual(withS6Division(yoloLoopMerge(existing, yoloCodes), existing.length));
  });
});

describe("normalizeCsiCode", () => {
  it("pads single-digit division to 2 chars", () => {
    expect(normalizeCsiCode("8")).toBe("08");
  });

  it("formats 6-digit numeric string with spaces", () => {
    expect(normalizeCsiCode("081116")).toBe("08 11 16");
  });

  it("strips punctuation variants", () => {
    expect(normalizeCsiCode("08-11-16")).toBe("08 11 16");
    expect(normalizeCsiCode("08.11.16")).toBe("08 11 16");
  });
});

describe("normalizeCsiCodes", () => {
  it("splits a comma-separated list and normalizes each entry", () => {
    expect(normalizeCsiCodes("8, 081116, 02 33 21")).toEqual([
      "08",
      "08 11 16",
      "02 33 21",
    ]);
  });
});

describe("[csi-v2 S6] normalizeCsiCode keeps Level-5 '.NN' suffixes", () => {
  it("spaced, unspaced and dotted Level-5 inputs all give 'NN NN NN.NN'", () => {
    // measured pre-S6 (c6ad951): all four → "00 24 13"
    for (const v of ["00 24 13.16", "00241316", "00.24.13.16", "002413.16"]) {
      expect(normalizeCsiCode(v)).toBe("00 24 13.16");
    }
  });
  it("Level 2–4 forms are unchanged", () => {
    expect(normalizeCsiCode("081113")).toBe("08 11 13");
    expect(normalizeCsiCode("08-11")).toBe("08 11");
    expect(normalizeCsiCode("ABC")).toBe("ABC");
    expect(normalizeCsiCodes("8, 00241316")).toEqual(["08", "00 24 13.16"]);
  });
});

describe("[csi-v2 S6] csiDivisionOf", () => {
  it("reads spaced, unspaced and Level-5 codes", () => {
    expect(csiDivisionOf("08 11 13")).toBe("08 00 00");
    expect(csiDivisionOf("081113")).toBe("08 00 00");
    expect(csiDivisionOf("00 24 13.16")).toBe("00 00 00");
  });
  it("a code without two leading digits keeps the old 2-character prefix", () => {
    expect(csiDivisionOf("AB-1")).toBe("AB");
  });
});

describe("[csi-v2 S6] mergeCsiCodes carries confidence (max)", () => {
  it("a duplicate raises the kept entry to the max confidence; the kept raw code and fields stay", () => {
    const existing: CsiCode[] = [{ code: "081113", description: "legacy", division: "08 00 00", trade: "t" }];
    const merged = mergeCsiCodes(existing, [
      { code: "08 11 13", description: "v2", confidence: 0.9 },
      { code: "23 05 00", description: "hvac", confidence: 0.7 },
      { code: "230500", description: "hvac dup", confidence: 0.8 },
      { code: "23-05-00", description: "hvac lower", confidence: 0.5 },
    ]);
    expect(merged).toEqual([
      { code: "081113", description: "legacy", division: "08 00 00", trade: "t", confidence: 0.9 },
      { code: "23 05 00", description: "hvac", division: "23 00 00", trade: "", confidence: 0.8 },
    ]);
    expect(existing[0]).not.toHaveProperty("confidence"); // input never mutated
  });
  it("codes without a numeric confidence (all pre-v2 data) gain no confidence key", () => {
    const merged = mergeCsiCodes([], [{ code: "09 00 00", description: "Finishes" }]);
    expect(merged[0]).not.toHaveProperty("confidence");
  });
  it("a lower incoming confidence does not lower the kept one", () => {
    const kept = { code: "09 29 00", description: "Gypsum", division: "09 00 00", trade: "", confidence: 0.95 };
    expect(mergeCsiCodes([kept], [{ code: "092900", description: "x", confidence: 0.4 }])).toEqual([kept]);
  });
});

describe("[csi-v2 S6] csiCodeMatchesQuery (CsiPanel search)", () => {
  const legacy = { code: "081113", description: "hollow metal doors" };
  const v2 = { code: "08 11 13", description: "Hollow Metal Doors and Frames" };
  it("matches across stored formats via csiDedupeKey", () => {
    // measured pre-S6 (raw substring): "0811" hit only legacy, "08 11" only v2, "08-11-13" neither
    for (const q of ["0811", "08 11", "08-11-13", "081113"]) {
      expect(csiCodeMatchesQuery(legacy, q), q).toBe(true);
      expect(csiCodeMatchesQuery(v2, q), q).toBe(true);
    }
  });
  it("description search is unchanged (case-insensitive substring)", () => {
    expect(csiCodeMatchesQuery(v2, "metal door")).toBe(true);
    expect(csiCodeMatchesQuery(v2, "gypsum")).toBe(false);
    expect(csiCodeMatchesQuery(v2, "09 21")).toBe(false);
  });
});

describe("[csi-v2 S6] csiTriggerHits (SearchHighlightOverlay)", () => {
  it("flatMaps per-word bboxes when present, else the single bbox (legacy triggers)", () => {
    const hits = csiTriggerHits([
      { text: "hollow metal doors", bbox: [0.1, 0.1, 0.3, 0.02], tier: 1, bboxes: [[0.1, 0.1, 0.1, 0.02], [0.2, 0.1, 0.2, 0.02]] },
      { text: "gyp bd", bbox: [0.5, 0.5, 0.1, 0.02], tier: 2 },
      { text: "empty", bbox: [0.7, 0.7, 0.1, 0.02], tier: 3, bboxes: [] },
    ]);
    expect(hits).toEqual([
      { text: "hollow metal doors", bbox: [0.1, 0.1, 0.1, 0.02] },
      { text: "hollow metal doors", bbox: [0.2, 0.1, 0.2, 0.02] },
      { text: "gyp bd", bbox: [0.5, 0.5, 0.1, 0.02] },
      { text: "empty", bbox: [0.7, 0.7, 0.1, 0.02] },
    ]);
  });
});

describe("[csi-v2 S6] csiCodesForLlm (LLM getPageDetails / detectCsiFromText)", () => {
  it("keeps {code, description, trade, confidence}; drops triggers and division", () => {
    const codes = [
      { code: "081113", description: "hollow metal doors", trade: "Openings", division: "08 00 00",
        triggers: [{ text: "hm door", bbox: [0, 0, 1, 1] as [number, number, number, number], tier: 1 as const }] },
      { code: "09 29 00", description: "Gypsum Board", trade: "Finishes", division: "09 00 00", confidence: 0.91 },
    ];
    expect(csiCodesForLlm(codes)).toEqual([
      { code: "081113", description: "hollow metal doors", trade: "Openings" },
      { code: "09 29 00", description: "Gypsum Board", trade: "Finishes", confidence: 0.91 },
    ]);
  });
  it("null / undefined stored codes → []", () => {
    expect(csiCodesForLlm(null)).toEqual([]);
    expect(csiCodesForLlm(undefined)).toEqual([]);
  });
});

describe("[csi-v2 S6] DEFAULT_CSI_V2_CONFIG (client-safe)", () => {
  it("is the IMPLEMENTATION §I default and frozen", () => {
    expect(DEFAULT_CSI_V2_CONFIG).toEqual({ tau: 0.75, maxCodesPerPage: 40 });
    expect(Object.isFrozen(DEFAULT_CSI_V2_CONFIG)).toBe(true);
  });
});
