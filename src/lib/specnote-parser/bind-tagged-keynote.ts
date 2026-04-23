import { RE_TAG_PREFIX, type LineFeature } from "./shared";

/**
 * Per-region binding for tagged-keynote notes (K-01, GN-1, AD.1, EN01A).
 * Mirrors bind-numbered.ts. A line whose first word matches a tag-prefix
 * pattern opens a new row; non-tag lines accumulate as continuation.
 *
 * Canonical use case: keynote callouts on architectural plans where the
 * tag is an alphanumeric identifier rather than a simple digit.
 *
 * Safety guards:
 * - Require ≥2 rows
 * - Require tag-column X uniformity (stddev of first-word right edge ≤
 *   2% of region width). This is what separates a true tagged list from
 *   stray tag-like tokens in prose (e.g. "refer to D-02 for details").
 */
export function bindTaggedKeynoteGrid(
  lines: readonly LineFeature[],
): { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[] } | undefined {
  const rows: Record<string, string>[] = [];
  const rowBoundaries: number[] = [];
  const firstWordRights: number[] = [];
  let current: { key: string; parts: string[]; top: number } | undefined;

  const ysorted = [...lines].sort((a, b) => a.top - b.top);
  for (const line of ysorted) {
    const match = RE_TAG_PREFIX.exec(line.line.text);
    if (match) {
      if (current) {
        rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
        rowBoundaries.push(current.top);
      }
      const key = match[1];
      const afterKey = line.line.text.slice(match[0].length).trim();
      current = { key, parts: afterKey ? [afterKey] : [], top: line.top };

      const firstWord = line.line.words?.[0];
      if (firstWord?.bbox && firstWord.bbox.length >= 4) {
        firstWordRights.push(firstWord.bbox[0] + firstWord.bbox[2]);
      }
    } else if (current) {
      current.parts.push(line.line.text.trim());
    }
  }
  if (current) {
    rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
    rowBoundaries.push(current.top);
  }

  if (rows.length < 2) return undefined;

  // Tag-column X uniformity check. Without this, stray "D-02" mid-sentence
  // tokens would hijack the bind.
  if (firstWordRights.length >= 2) {
    const mean = firstWordRights.reduce((s, x) => s + x, 0) / firstWordRights.length;
    const variance =
      firstWordRights.reduce((s, x) => s + (x - mean) ** 2, 0) / firstWordRights.length;
    const stddev = Math.sqrt(variance);
    if (stddev > 0.02) return undefined;
  }

  // Pattern uniformity: require all keys to share the same alphabetic prefix.
  // "K-01, K-02, K-03" passes; "K-01, D-02, X-99" fails (likely stray refs).
  const prefixes = rows.map((r) => (r.Key as string).replace(/[\d.\-]+/g, "").toUpperCase());
  const uniquePrefixes = new Set(prefixes);
  if (uniquePrefixes.size > Math.max(1, Math.floor(rows.length * 0.25))) return undefined;

  return {
    headers: ["Key", "Note"],
    rows,
    rowBoundaries,
  };
}
