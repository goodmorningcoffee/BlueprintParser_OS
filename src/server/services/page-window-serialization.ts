// [refactor jul11 P2.2⑦ C4 / PW-D9] Response-only PageIntelligence slimming for the two
// `/pages` window endpoints. PageIntelligence is mixed-ownership JSONB: computed server fields,
// user-authored fields, and unknown future fields coexist. Keep a narrow denylist instead of an
// allowlist so a response optimization can never eat user or forward-compatible data.

const PAGE_WINDOW_OMITTED_INTELLIGENCE_KEYS = [
  "classifiedRegions",
  "yoloHeatmap",
  "csiSpatialMap",
  "autoTableProposals",
  // [evidence T4 2026-10-24] up to 500 hole boxes per page; server consumers (LLM context) only.
  "evidence",
  // [viewer trim F1 2026-10-24] read only by server code (map-tags ensemble context, enrichment,
  // knowledge graph); shapes alone runs to ~45 KB on a dense page.
  "shapes",
  "regionsV2",
] as const;

/**
 * Return the PageIntelligence value safe to expose through a page-window response.
 *
 * This deliberately preserves the endpoints' historical `value || null` normalization. JSON
 * objects are shallow-cloned before the response-only fields are removed; arrays and truthy
 * scalar legacy JSON values pass through unchanged. The source value is never mutated because the
 * same DB payload remains authoritative for server pipelines, LLM context, exports, and reprocess.
 */
export function serializePageWindowIntelligence(value: unknown): unknown {
  const normalized = value || null;

  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }

  const serialized = { ...(normalized as Record<string, unknown>) };
  for (const key of PAGE_WINDOW_OMITTED_INTELLIGENCE_KEYS) {
    delete serialized[key];
  }
  return serialized;
}
