import { RE_NUMBERED_ITEM, type LineFeature } from "./shared";

/**
 * Per-region binding for notes-numbered regions. Lines whose first word
 * matches `1.` / `2)` / `(3)` style prefixes open a new row; subsequent
 * non-numbered lines accumulate as continuation text on the current row.
 */
export function bindNumberedGrid(
  lines: readonly LineFeature[],
): { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[] } | undefined {
  const rows: Record<string, string>[] = [];
  const rowBoundaries: number[] = [];
  let current: { key: string; parts: string[]; top: number } | undefined;

  const ysorted = [...lines].sort((a, b) => a.top - b.top);
  for (const line of ysorted) {
    const match = RE_NUMBERED_ITEM.exec(line.firstWord);
    if (match) {
      if (current) {
        rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
        rowBoundaries.push(current.top);
      }
      const key = match[1];
      const afterKey = line.line.text.replace(/^\s*\(?\d{1,3}\s*[.):]\s*/, "").trim();
      current = { key, parts: afterKey ? [afterKey] : [], top: line.top };
    } else if (current) {
      current.parts.push(line.line.text.trim());
    }
  }
  if (current) {
    rows.push({ Key: current.key, Note: current.parts.join(" ").trim() });
    rowBoundaries.push(current.top);
  }

  if (rows.length === 0) return undefined;
  return {
    headers: ["Key", "Note"],
    rows,
    rowBoundaries,
  };
}
