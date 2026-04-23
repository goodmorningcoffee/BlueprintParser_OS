import { RE_LETTERED_ITEM, type LineFeature } from "./shared";

/**
 * Per-region binding for lettered-items notes (A. B. C. / a) b) c)). Mirrors
 * bind-numbered.ts; a line whose first word matches the lettered-item regex
 * opens a new row, subsequent non-lettered lines accumulate as continuation.
 *
 * Canonical use case: Building Department Notes, General Notes with lettered
 * enumeration instead of numbers. Seen in `notes examples.png`.
 *
 * Guard rails: requires ≥2 rows AND a monotonic letter sequence (A→B→C or
 * a→b→c with ≤1 skip) — otherwise single stray `A.` in prose would hijack
 * the parse. This is what keeps the new binder safe to run unconditionally
 * alongside bind-numbered during the serial-fallback phase.
 */
export function bindLetteredGrid(
  lines: readonly LineFeature[],
): { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[] } | undefined {
  const rows: Record<string, string>[] = [];
  const rowBoundaries: number[] = [];
  let current: { key: string; parts: string[]; top: number } | undefined;

  const ysorted = [...lines].sort((a, b) => a.top - b.top);
  for (const line of ysorted) {
    const match = RE_LETTERED_ITEM.exec(line.firstWord);
    if (match) {
      if (current) {
        rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
        rowBoundaries.push(current.top);
      }
      const key = match[1];
      const afterKey = line.line.text.replace(/^\s*\(?[A-Za-z]\s*[.):]\s*/, "").trim();
      current = { key, parts: afterKey ? [afterKey] : [], top: line.top };
    } else if (current) {
      current.parts.push(line.line.text.trim());
    }
  }
  if (current) {
    rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
    rowBoundaries.push(current.top);
  }

  if (rows.length < 2) return undefined;

  // Sequence-coherence guard: reject if the letter sequence is chaotic.
  // Normalize case, require that consecutive keys advance by ≤2 in the
  // alphabet (allowing one skip for OCR drops like A, B, D).
  const codes = rows.map((r) => (r.Key as string).toUpperCase().charCodeAt(0));
  let advances = 0;
  let violations = 0;
  for (let i = 1; i < codes.length; i++) {
    const d = codes[i] - codes[i - 1];
    if (d >= 1 && d <= 2) advances++;
    else violations++;
  }
  if (advances < rows.length - 1 - Math.ceil(rows.length * 0.2)) return undefined;
  if (violations > Math.max(1, Math.floor(rows.length * 0.2))) return undefined;

  return {
    headers: ["Key", "Note"],
    rows,
    rowBoundaries,
  };
}
