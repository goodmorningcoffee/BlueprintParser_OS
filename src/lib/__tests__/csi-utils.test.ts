import { describe, it, expect } from "vitest";
import { mergeCsiCodes, normalizeCsiCode, normalizeCsiCodes } from "@/lib/csi-utils";
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

  it("derives division from code substring when not provided", () => {
    const merged = mergeCsiCodes([], [
      { code: "08 11 16", description: "Aluminum Doors" },
    ]);
    expect(merged[0].division).toBe("08");
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

  it("documents WHY normalizeCsiCode must NOT be the dedupe key: it truncates Level-4 to 6 digits (two distinct siblings normalize IDENTICALLY)", () => {
    expect(normalizeCsiCode("00 24 13.16")).toBe("00 24 13");
    expect(normalizeCsiCode("00 24 13.13")).toBe("00 24 13");
    // Both dotted siblings collapse to "00 24 13" — proof that keying dedupe on
    // normalizeCsiCode would silently drop one of two genuinely different codes.
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

  it("reproduces the loop's objects byte-for-byte (empty existing)", () => {
    const existing: CsiCode[] = [];
    const yoloCodes = ["08 11 00", "23 05 00"];
    const viaMerge = mergeCsiCodes(
      existing,
      yoloCodes.map((code) => ({ code, description: "From YOLO class config" })),
    );
    expect(viaMerge).toEqual(yoloLoopMerge(existing, yoloCodes));
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
    expect(viaMerge).toEqual(yoloLoopMerge(existing, yoloCodes));
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
