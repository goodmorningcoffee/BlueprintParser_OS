/**
 * csi-spatial.test.ts — computeCsiSpatialMap FREEZE-FIRST division pins.
 *
 * [refactor jul9 P2-A C1] Commit C0 of the CSI Option C1 server-half arc
 * (SPEC_FINAL §6.2-2, C2-F4). Pins the CURRENT (pre-C2) division-allowlist
 * behavior of the spatial heatmap, INCLUDING the live recall bug: csi-spatial's
 * local 19-division DIVISION_NAMES table is missing divisions
 * 13/14/25/31/32/33, so `addCode` silently drops those codes (the
 * `if (!DIVISION_NAMES[div]) return;` gate).
 *
 * The Div-13-ABSENT pins below are DELIBERATE bug pins (freeze-first
 * doctrine): commit C2 adopts the canonical 25-division map
 * (@/lib/csi-divisions) and FLIPS them — Div 13/31 etc. become present —
 * re-pinned there with the [C1 approval 2026-07-09] citation (ledger D-7).
 * The Div 00/01 pins are anti-regression guards (both divisions are already
 * in the local table — SPEC_FINAL I-8) and must NOT flip in C2.
 */
import { describe, it, expect } from "vitest";
import { computeCsiSpatialMap } from "@/lib/csi-spatial";
import type { TextAnnotation, CsiCode } from "@/types";

function tag(code: string): CsiCode {
  const div = code.substring(0, 2);
  return {
    code,
    description: `fixture ${code}`,
    trade: `Trade ${div}`,
    division: `${div} 00 00`,
  };
}

function ann(code: string, bbox: [number, number, number, number]): TextAnnotation {
  return {
    type: "csi-code",
    category: "csi",
    text: `fixture ${code}`,
    bbox, // [left, top, width, height] normalized 0-1
    confidence: 0.9,
    wordIndices: [],
    csiTags: [tag(code)],
  };
}

/** Collect every division code that appears anywhere in the returned zones. */
function divisionsIn(map: ReturnType<typeof computeCsiSpatialMap>): string[] {
  if (!map) return [];
  const divs = new Set<string>();
  for (const zone of map.zones) {
    for (const d of zone.divisions) divs.add(d.division);
  }
  return [...divs].sort();
}

describe("computeCsiSpatialMap — division allowlist baseline (pre-C2)", () => {
  // Distinct bbox centers → distinct 9x9 grid zones; all in the drawing area
  // (below the title-block / right-margin special-zone thresholds).
  const ANN_00 = ann("00 10 00", [0.1, 0.1, 0.1, 0.1]); // center (0.15, 0.15)
  const ANN_01 = ann("01 10 00", [0.4, 0.4, 0.1, 0.1]); // center (0.45, 0.45)
  const ANN_13 = ann("13 05 00", [0.2, 0.2, 0.1, 0.1]); // center (0.25, 0.25)

  it("bins Div 00 and Div 01, but DROPS Div 13 (pinned recall bug — C2 flips this)", () => {
    const map = computeCsiSpatialMap(1, [ANN_00, ANN_01, ANN_13]);
    expect(map).not.toBeNull();

    // Anti-regression pins (I-8): Div 00 and Div 01 ARE in the local table.
    // These must survive C2 unchanged — the canonical map must be the
    // 25-union, not csi-graph's 24-set (which lacks Div 00).
    expect(divisionsIn(map)).toEqual(["00", "01"]);

    // The bug pin, spelled out: Div 13 ("13 05 00") was tagged on the page
    // but is absent from every zone. [refactor jul9 P2-A C1] C2 re-pins this
    // to PRESENT with citation (SPEC_FINAL §6.2-2, ledger D-7).
    expect(divisionsIn(map)).not.toContain("13");
  });

  it("pins the current division names for Div 00/01 zones", () => {
    const map = computeCsiSpatialMap(1, [ANN_00, ANN_01, ANN_13])!;
    const names = new Map(
      map.zones.flatMap((z) => z.divisions.map((d) => [d.division, d.name] as const)),
    );
    expect(names.get("00")).toBe("Procurement");
    expect(names.get("01")).toBe("General Requirements");
  });

  it("returns NULL when every tagged element falls in a gated-out division (pinned recall bug — C2 flips this)", () => {
    // Both Div 31 and Div 13 are missing from the pre-C2 local table, so
    // every code is dropped, the accumulator stays empty, and the function
    // returns null — the page loses its spatial map entirely.
    // [refactor jul9 P2-A C1] C2's regression test asserts both divisions
    // PRESENT for exactly this shape of fixture (SPEC_FINAL §6.2-6).
    const map = computeCsiSpatialMap(1, [
      ann("31 20 00", [0.1, 0.1, 0.1, 0.1]),
      ann("13 05 00", [0.4, 0.4, 0.1, 0.1]),
    ]);
    expect(map).toBeNull();
  });
});
