/**
 * csi-colors.ts — Single source of truth for CSI MasterFormat division COLORS
 * and discipline groupings.
 *
 * Used by the CSI network graph page and the docs showcase.
 *
 * [refactor jul9 P2-A C1 R2] Division NAMES no longer live here — the local
 * DIVISION_NAMES table (byte-dup, 24 divisions missing Div 00) was folded into
 * the canonical @/lib/csi-divisions map (SPEC_FINAL §4.2 / N-2; owner "Fold them"
 * 2026-07-09). We RE-EXPORT the canonical below so existing consumers (the docs
 * constants.ts barrel → CsiChipDemo/CsiSpatialHeatmapDemo/CsiDivisionChipGrid)
 * keep importing DIVISION_NAMES from here unchanged. Sole behavior delta: the
 * re-exported map now includes "00":"Procurement" (ledger D-8 class). The COLOR
 * tables (DIVISION_COLORS/GROUP_COLORS) stay local and untouched (N-3).
 */

export type CsiDivisionGroup =
  | "MEP"
  | "Architectural"
  | "Structural"
  | "Site"
  | "Other";

export interface CsiDivisionMeta {
  color: string;
  group: CsiDivisionGroup;
}

// [refactor jul9 P2-A C1 R2] Human-readable division names: re-exported from the
// canonical map (was a byte-dup local table). Consumers import DIVISION_NAMES from
// "@/lib/csi-colors" unchanged; see file header for the fold rationale (N-2).
export { DIVISION_NAMES } from "@/lib/csi-divisions";

/**
 * Color + group mapping for every CSI division we style. Groups are chosen
 * so related disciplines share a hue (MEP = blue, Architectural = green,
 * Structural = orange, Site = amber).
 */
export const DIVISION_COLORS: Record<string, CsiDivisionMeta> = {
  // MEP (blue family)
  "21": { color: "#38bdf8", group: "MEP" },
  "22": { color: "#3b82f6", group: "MEP" },
  "23": { color: "#60a5fa", group: "MEP" },
  "26": { color: "#2563eb", group: "MEP" },
  "27": { color: "#818cf8", group: "MEP" },
  "28": { color: "#6366f1", group: "MEP" },
  // Architectural (green family)
  "08": { color: "#22c55e", group: "Architectural" },
  "09": { color: "#4ade80", group: "Architectural" },
  "10": { color: "#a7f3d0", group: "Architectural" },
  "12": { color: "#86efac", group: "Architectural" },
  // Structural (orange family)
  "03": { color: "#f97316", group: "Structural" },
  "04": { color: "#fdba74", group: "Structural" },
  "05": { color: "#fb923c", group: "Structural" },
  "06": { color: "#fbbf24", group: "Structural" },
  // Site (amber family)
  "31": { color: "#a16207", group: "Site" },
  "32": { color: "#ca8a04", group: "Site" },
  "33": { color: "#d97706", group: "Site" },
};

/** Representative color per discipline group, used for legend chips. */
export const GROUP_COLORS: Record<CsiDivisionGroup, string> = {
  MEP: "#3b82f6",
  Architectural: "#22c55e",
  Structural: "#f97316",
  Site: "#a16207",
  Other: "#6b7280",
};

/** Look up a division's color + group, with a neutral fallback for unknowns. */
export function getDivColor(div: string): CsiDivisionMeta {
  return DIVISION_COLORS[div] || { color: "#6b7280", group: "Other" };
}
