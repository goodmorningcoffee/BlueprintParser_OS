/**
 * csi-divisions.ts — CANONICAL CSI division-name map.
 *
 * [refactor jul9 P2-A C1] Commit C2 of the CSI Option C1 server-half arc
 * (SPEC_FINAL §1.3/§4.1, [C1 approval 2026-07-09]). Single source of truth
 * replacing three previously-divergent local tables:
 *   - csi-spatial.ts (was 19 divisions — missing 13/14/25/31/32/33, the live
 *     spatial recall bug, ledger D-7),
 *   - csi-graph.ts   (was 24 divisions — missing 00),
 *   - csi-upload.ts  DIVISION_TRADES (25 divisions — same set as this map).
 *
 * The 25 divisions here = the verified union of all in-repo tables (exactly
 * csi-upload's set). Wording = majority rule across the 6 in-repo instances
 * (4-of-6 agree), which minimizes observable label deltas — only 3 strings
 * moved anywhere (ledger D-8/D-9):
 *   - Div 06 "Wood/Plastics" → "Wood/Plastics/Composites" (spatial only),
 *   - Div 07 "Thermal & Moisture Protection" → "Thermal & Moisture" (upload only),
 *   - Div 28 "Electronic Safety & Security" → "Electronic Safety" (upload only).
 *
 * Deliberately NOT folded here (SPEC_FINAL §4.2 / NEEDS-OWNER):
 *   - project-analysis.ts + csi-colors.ts byte-dup tables (rider R2, N-2),
 *   - CsiPanel.tsx viewer table (hard-excluded),
 *   - masterformat.tsv divisions 34/35/40-46/48 (N-3 — extending needs
 *     owner color/cluster decisions; the canonical set stays this 25-union).
 *
 * MUST stay client-safe pure data (no imports): csi-spatial runs in the
 * browser via csi-spatial-refresh.ts against the hot viewer store.
 */

export const DIVISION_NAMES: Readonly<Record<string, string>> = {
  "00": "Procurement",            "01": "General Requirements",  "02": "Existing Conditions",
  "03": "Concrete",               "04": "Masonry",               "05": "Metals",
  "06": "Wood/Plastics/Composites", "07": "Thermal & Moisture",  "08": "Openings",
  "09": "Finishes",               "10": "Specialties",           "11": "Equipment",
  "12": "Furnishings",            "13": "Special Construction",  "14": "Conveying Equipment",
  "21": "Fire Suppression",       "22": "Plumbing",              "23": "HVAC",
  "25": "Integrated Automation",  "26": "Electrical",            "27": "Communications",
  "28": "Electronic Safety",      "31": "Earthwork",             "32": "Exterior Improvements",
  "33": "Utilities",
};
