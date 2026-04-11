/**
 * csi-colors.ts — Single source of truth for CSI MasterFormat division colors,
 * discipline groupings, and human-readable names.
 *
 * Used by the CSI network graph page, the CsiPanel chips, and the docs
 * showcase. Update values here once and every surface picks it up.
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

/** Human-readable name for each CSI division code (2-digit). */
export const DIVISION_NAMES: Record<string, string> = {
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
};

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
