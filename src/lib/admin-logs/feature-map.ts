/**
 * Route → human-readable feature label whitelist.
 *
 * Used by the Logs tab's "Top 10 features" panel to filter the raw
 * CloudWatch Logs Insights aggregation (by path+method) to only the
 * endpoints that represent a real user-initiated action. Auto-fetch GETs,
 * health checks, and internal polls are excluded on purpose.
 *
 * Add new features here as they ship. Historical log data becomes queryable
 * retroactively — the map is applied at query time on the server, not
 * at log-write time.
 *
 * Key format: `"${METHOD} ${PATH}"` — methods are uppercase, paths are the
 * raw router path (no trailing slash). Dynamic segments match by prefix, see
 * `labelFor()` below.
 */

type RouteKey = `${"GET" | "POST" | "PUT" | "DELETE" | "PATCH"} ${string}`;

const EXACT_MAP: Record<RouteKey, string> = {
  // Parsing + CV
  "POST /api/table-parse": "Parse Table",
  "POST /api/table-structure": "Table Structure (TATR)",
  "POST /api/symbol-search": "Symbol Search",
  "POST /api/shape-parse": "Shape Parse (Keynotes)",
  "POST /api/bucket-fill": "Bucket Fill",
  "POST /api/notes-parse": "Notes Parse",
  "POST /api/notes-parse/propose": "Notes Parse — Propose",
  "POST /api/spec-parse": "Spec Parse",
  "POST /api/spec-parse/propose": "Spec Parse — Propose",
  "POST /api/auto-detect-tables": "Auto-Detect Tables",

  // Parser commit / saves
  "POST /api/regions/promote": "Save Parsed Region",
  "POST /api/annotations": "Create Annotation",
  "POST /api/markup": "Create Markup",
  "POST /api/takeoff-items": "Save Takeoff Item",
  "POST /api/takeoff-groups": "Create Takeoff Group",

  // Chat + LLM
  "POST /api/ai/chat": "LLM Chat",

  // Heavy workflows
  "POST /api/auto-qto": "Run Auto-QTO Workflow",
  "POST /api/yolo/run": "Run YOLO Model",
  "POST /api/labeling/create": "Create Labeling Project",
  "POST /api/pages/textract-rerun": "Re-run Textract",

  // Project lifecycle
  "POST /api/projects": "Create Project",
  "POST /api/s3/staging-credentials": "Upload Files",
};

/**
 * Dynamic-segment prefixes. Any path that starts with the given prefix maps
 * to the label. Applied only if no exact EXACT_MAP key matches first.
 */
const PREFIX_MAP: Array<{ method: string; prefix: string; label: string }> = [
  { method: "DELETE", prefix: "/api/projects/", label: "Delete Project" },
  { method: "DELETE", prefix: "/api/annotations/", label: "Delete Annotation" },
  { method: "DELETE", prefix: "/api/takeoff-items/", label: "Delete Takeoff Item" },
];

export function labelFor(method: string, path: string): string | null {
  const upperMethod = method.toUpperCase();
  const key = `${upperMethod} ${path}` as RouteKey;
  if (key in EXACT_MAP) return EXACT_MAP[key];
  for (const { method: m, prefix, label } of PREFIX_MAP) {
    if (m === upperMethod && path.startsWith(prefix)) return label;
  }
  return null;
}

/**
 * All labels in order they should appear in UI if hits are tied. Useful for
 * stable sort in the top-10 display.
 */
export const ALL_FEATURE_LABELS = [
  ...Object.values(EXACT_MAP),
  ...PREFIX_MAP.map((p) => p.label),
];
