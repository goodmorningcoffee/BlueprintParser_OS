// Text normalization for duplicate-page detection (owner method, OWNER_INPUT_2026-10-21):
// lowercase, strip punctuation, collapse whitespace. raw_text keeps one OCR line per "\n"
// (extractRawText joins Textract lines with "\n", src/lib/textract.ts), which is what lets the
// boilerplate pass work line by line.

/** Lowercase, punctuation → space, collapse whitespace. ASCII alphanumerics only (ES2017-safe). */
export function normalizeLine(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Normalized, non-empty lines of a page's raw text. */
export function normalizedLines(rawText: string | null): string[] {
  if (!rawText) return [];
  const out: string[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    const n = normalizeLine(line);
    if (n) out.push(n);
  }
  return out;
}

/** The drawing number in normalized form ("A-101.00" → "a 101 00"), or null. */
export function normalizeDrawingNumber(drawingNumber: string | null): string | null {
  if (!drawingNumber) return null;
  const n = normalizeLine(drawingNumber);
  return n || null;
}

/** Compact comparison key for drawing numbers ("A-101" and "A101" compare equal). */
export function drawingKey(drawingNumber: string | null): string | null {
  const n = normalizeDrawingNumber(drawingNumber);
  return n ? n.replace(/ /g, "") : null;
}

/** Remove every whole-token occurrence of `phrase` from a normalized line. */
export function removePhrase(line: string, phrase: string | null): string {
  if (!phrase) return line;
  const padded = ` ${line} `.split(` ${phrase} `).join(" ");
  return padded.replace(/\s+/g, " ").trim();
}

export const BOILERPLATE_SHARE = 0.6;
export const BOILERPLATE_MIN_PAGES = 5;

/**
 * Lines that appear on ≥ 60 % of the project's pages (title block, border, general notes
 * stamp). Only for projects of ≥ 5 pages — on a two-page project every shared line would
 * qualify and two identical sheets would strip to nothing.
 */
export function boilerplateLines(pagesLines: readonly string[][]): Set<string> {
  const result = new Set<string>();
  const n = pagesLines.length;
  if (n < BOILERPLATE_MIN_PAGES) return result;
  const threshold = Math.max(3, Math.ceil(BOILERPLATE_SHARE * n));
  const counts = new Map<string, number>();
  for (const lines of pagesLines) {
    for (const line of new Set(lines)) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  for (const [line, count] of counts) if (count >= threshold) result.add(line);
  return result;
}

/** Whitespace tokens of a list of normalized lines. */
export function tokensOf(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) for (const t of line.split(" ")) if (t) out.push(t);
  return out;
}
