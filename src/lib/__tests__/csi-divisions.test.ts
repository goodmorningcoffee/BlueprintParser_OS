/**
 * csi-divisions.test.ts — canonical division map pins.
 *
 * [refactor jul9 P2-A C1] Commit C2 of the CSI Option C1 server-half arc
 * (SPEC_FINAL §6.2-6, [C1 approval 2026-07-09]). The canonical map MUST be
 * exactly the 25-division union of the old in-repo tables — guards against a
 * future "simplification" to csi-graph's 24-set, which would silently regress
 * Div 00 out of the spatial heatmap (SPEC_FINAL §4.3 anti-regression note).
 */
import { describe, it, expect } from "vitest";
import { DIVISION_NAMES } from "@/lib/csi-divisions";

describe("DIVISION_NAMES — canonical 25-division map", () => {
  it("has exactly the 25 canonical division keys (sorted)", () => {
    expect(Object.keys(DIVISION_NAMES).sort()).toEqual([
      "00", "01", "02", "03", "04", "05", "06", "07", "08", "09",
      "10", "11", "12", "13", "14",
      "21", "22", "23", "25", "26", "27", "28",
      "31", "32", "33",
    ]);
  });

  it("pins the exact canonical labels (SPEC_FINAL §4.1 — majority-rule wording)", () => {
    expect(DIVISION_NAMES).toEqual({
      "00": "Procurement",
      "01": "General Requirements",
      "02": "Existing Conditions",
      "03": "Concrete",
      "04": "Masonry",
      "05": "Metals",
      "06": "Wood/Plastics/Composites",
      "07": "Thermal & Moisture",
      "08": "Openings",
      "09": "Finishes",
      "10": "Specialties",
      "11": "Equipment",
      "12": "Furnishings",
      "13": "Special Construction",
      "14": "Conveying Equipment",
      "21": "Fire Suppression",
      "22": "Plumbing",
      "23": "HVAC",
      "25": "Integrated Automation",
      "26": "Electrical",
      "27": "Communications",
      "28": "Electronic Safety",
      "31": "Earthwork",
      "32": "Exterior Improvements",
      "33": "Utilities",
    });
  });
});
