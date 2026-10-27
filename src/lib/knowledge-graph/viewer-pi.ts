/**
 * projectIntelligence as the signed-in viewer bootstrap ships it (table pipeline PLAN §1.6 rule 9,
 * §2.2; WP-3.H, C1-B3). Large or server-only project keys are stripped HERE, never in
 * `publicProjectIntelligence` (which strips only the demo-private cross-set summary, and whose test
 * pins exactly that):
 *   - `tagMaps` (TP-4; up to 2 MB per project) — read through `GET …/parse-engine/tag-map`;
 *   - `structureIndex.keys`, `.specSections`, `.inbox` — server-only slices of the derived index
 *     (`lib/parse-engine/index-derive.ts`); the viewer gets `v`, `at` and `regions` only.
 * Pure. Returns the input object itself when there is nothing to strip, so existing bootstraps are
 * byte-identical.
 */

export const VIEWER_STRIPPED_PI_KEYS = ["tagMaps"] as const;
export const VIEWER_STRIPPED_INDEX_KEYS = ["keys", "specSections", "inbox"] as const;

export function viewerProjectIntelligence<T extends Record<string, unknown>>(projectIntelligence: T): T {
  const index = projectIntelligence.structureIndex;
  const indexIsObject = !!index && typeof index === "object" && !Array.isArray(index);
  const stripIndex = indexIsObject && VIEWER_STRIPPED_INDEX_KEYS.some((k) => k in (index as object));
  const stripTop = VIEWER_STRIPPED_PI_KEYS.some((k) => k in projectIntelligence);
  if (!stripIndex && !stripTop) return projectIntelligence;
  const out: Record<string, unknown> = { ...projectIntelligence };
  for (const k of VIEWER_STRIPPED_PI_KEYS) delete out[k];
  if (stripIndex) {
    const slim: Record<string, unknown> = { ...(index as Record<string, unknown>) };
    for (const k of VIEWER_STRIPPED_INDEX_KEYS) delete slim[k];
    out.structureIndex = slim;
  }
  return out as T;
}
