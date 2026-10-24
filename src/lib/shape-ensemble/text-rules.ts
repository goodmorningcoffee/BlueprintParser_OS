// [tag-mapping v2 2026-10-24] Pure text predicates shared by the shape ensemble and the tag
// matchers — the owner's rules from the 2026-10-23/24 gold session (research/INPUT_gaussian_session):
//   2. a 1–2-character tag counts only inside a shape or standing alone, never inside a sentence;
//   3. dimensions (8'-0", 3'-6", 12") are never tags;
//   4. keep full strings ("D1" ≠ "1");
//   and the labelfactory sheet-number guard: a mark equal to a project sheet number (modulo
//   separators, "E-1" = "E1") is a sheet REFERENCE, not a tag.

/** Tag-like token: optional 0–3 letter prefix, optional hyphen, 1–4 digits, optional letter suffix
 *  ("D-101", "T01", "3", "A1"), or a 1–2 letter mark with an optional digit ("W", "PF", "L2"). */
export const TAG_LIKE = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$|^[A-Z]{1,2}\d?$/;

/** Words that read as tag-like but are prose on a sheet (labelfactory stop list + common OCR). */
export const TAG_STOP_WORDS: ReadonlySet<string> = new Set([
  "OF", "ON", "NO", "TO", "AT", "BY", "IN", "OR", "AS", "IF", "IS", "IT", "AN", "BE", "DO", "GO", "SO", "UP", "US", "WE",
]);

export function normalizeTagText(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

export function isTagLike(text: string): boolean {
  const t = normalizeTagText(text);
  return TAG_LIKE.test(t) && !TAG_STOP_WORDS.has(t);
}

/** A 1–2 character tag (owner rule 2 applies). */
export function isShortTag(text: string): boolean {
  return normalizeTagText(text).length <= 2;
}

/**
 * Dimension strings are never tags (owner rule 3): feet/inch marks (8'-0", 3'-6", 12", 1'-0 1/2"),
 * metric with a unit (450MM, 2.4M), fractions (1/2) and a bare number followed by a unit mark.
 */
export function looksLikeDimension(text: string): boolean {
  const t = normalizeTagText(text).replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
  if (!t) return false;
  if (/['"]/.test(t) && /\d/.test(t)) return true;                 // 8'-0", 12", 3'
  if (/^\d+(\.\d+)?\s*(MM|CM|M|FT|IN)\.?$/.test(t)) return true;    // 450MM, 2.4M
  if (/^\d+\s*\/\s*\d+$/.test(t)) return true;                       // 1/2
  if (/^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(t)) return true;             // 2-1/2
  return false;
}

/** Comparison key for sheet numbers: "A-101.00" / "A101.00" / "a 101 00" all compare equal. */
export function sheetKey(sheet: string | null | undefined): string | null {
  if (!sheet) return null;
  const k = sheet.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k || null;
}

/** Set of comparison keys for a project's drawing numbers (nulls and blanks dropped). */
export function sheetKeySet(sheetNumbers: readonly (string | null | undefined)[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of sheetNumbers ?? []) {
    const k = sheetKey(s);
    if (k) out.add(k);
  }
  return out;
}

/** True when `text` names one of the project's sheets (the sheet-number guard). */
export function isSheetNumber(text: string, sheets: ReadonlySet<string>): boolean {
  const k = sheetKey(text);
  return k != null && sheets.has(k);
}

/** Two OCR reads of the same glyphs: equal after dropping separators and spaces. */
export function sameRead(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/** Digits → "9": the family pattern of a tag string ("D-101" → "D-999", "T01" → "T99"). */
export function tagPattern(text: string): string {
  return normalizeTagText(text).replace(/\d/g, "9");
}
