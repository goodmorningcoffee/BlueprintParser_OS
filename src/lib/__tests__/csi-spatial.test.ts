/**
 * csi-spatial.test.ts — computeCsiSpatialMap division pins.
 *
 * [refactor jul9 P2-A C1] Written as FREEZE-FIRST bug pins in commit C0
 * (pre-C2 local 19-division table dropped divisions 13/14/25/31/32/33 —
 * the live spatial recall bug). RE-PINNED in commit C2 with the
 * [C1 approval 2026-07-09] citation (SPEC_FINAL §6.2-2/§6.2-6, ledger D-7):
 * csi-spatial now uses the canonical 25-division map (@/lib/csi-divisions),
 * so codes in those six divisions bin into zones from ALL collectors.
 *
 * The Div 00/01 pins are anti-regression guards (both were already in the
 * old local table — SPEC_FINAL I-8) and did NOT flip in C2; they guard that
 * the canonical map stays the 25-union (not csi-graph's 24-set, which
 * lacks Div 00).
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

describe("computeCsiSpatialMap — canonical 25-division map (post-C2)", () => {
  // Distinct bbox centers → distinct 9x9 grid zones; all in the drawing area
  // (below the title-block / right-margin special-zone thresholds).
  const ANN_00 = ann("00 10 00", [0.1, 0.1, 0.1, 0.1]); // center (0.15, 0.15)
  const ANN_01 = ann("01 10 00", [0.4, 0.4, 0.1, 0.1]); // center (0.45, 0.45)
  const ANN_13 = ann("13 05 00", [0.2, 0.2, 0.1, 0.1]); // center (0.25, 0.25)

  it("bins Div 00, Div 01 AND Div 13 (recall bug fixed — was Div-13-ABSENT pre-C2) [C1 approval 2026-07-09, D-7]", () => {
    const map = computeCsiSpatialMap(1, [ANN_00, ANN_01, ANN_13]);
    expect(map).not.toBeNull();

    // Anti-regression pins (I-8): Div 00 and Div 01 were ALWAYS binned —
    // these two must never flip. Div 13 is the sanctioned C2 flip: the C0
    // baseline pinned it ABSENT (bug), the canonical map recovers it.
    expect(divisionsIn(map)).toEqual(["00", "01", "13"]);
    expect(divisionsIn(map)).toContain("13");
  });

  it("pins the canonical division names for Div 00/01/13 zones", () => {
    const map = computeCsiSpatialMap(1, [ANN_00, ANN_01, ANN_13])!;
    const names = new Map(
      map.zones.flatMap((z) => z.divisions.map((d) => [d.division, d.name] as const)),
    );
    expect(names.get("00")).toBe("Procurement");
    expect(names.get("01")).toBe("General Requirements");
    expect(names.get("13")).toBe("Special Construction");
  });

  it("recall-bug regression (SPEC_FINAL §6.2-6): a page tagged ONLY in formerly-gated divisions gets a spatial map [C1 approval 2026-07-09, D-7]", () => {
    // Pre-C2 this exact fixture returned NULL (both divisions gated out ⇒
    // empty bins ⇒ null) — the page lost its spatial map entirely. Pinned
    // as the null-return bug in the C0 baseline; flipped here.
    const map = computeCsiSpatialMap(1, [
      ann("31 20 00", [0.1, 0.1, 0.1, 0.1]),
      ann("13 05 00", [0.4, 0.4, 0.1, 0.1]),
    ]);
    expect(map).not.toBeNull();
    expect(divisionsIn(map)).toEqual(["13", "31"]);
  });

  it("recovers the remaining formerly-gated divisions 14/25/32/33 too", () => {
    const map = computeCsiSpatialMap(1, [
      ann("14 20 00", [0.1, 0.1, 0.1, 0.1]),
      ann("25 50 00", [0.3, 0.1, 0.1, 0.1]),
      ann("32 10 00", [0.1, 0.4, 0.1, 0.1]),
      ann("33 40 00", [0.4, 0.4, 0.1, 0.1]),
    ]);
    expect(divisionsIn(map)).toEqual(["14", "25", "32", "33"]);
  });

  it("still gates non-canonical masterformat divisions (34/40/48 etc — SPEC_FINAL N-3)", () => {
    // The allowlist gate itself is deliberately kept: divisions outside the
    // canonical 25-union stay excluded from the heatmap.
    const map = computeCsiSpatialMap(1, [
      ann("34 10 00", [0.1, 0.1, 0.1, 0.1]),
      ann("48 10 00", [0.4, 0.4, 0.1, 0.1]),
    ]);
    expect(map).toBeNull();
  });
});
