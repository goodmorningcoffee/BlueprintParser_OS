// [graph T8 2026-10-24] Sheet-number normalisation and the two token shapes the builder needs.
// Pure; shared by the builder, the reprocess scope and the corpus measurement script.

/** Sheet number as written anywhere on a drawing: A-101, A101, A 101, E-300.00, FA-001, T001.04, GSQ22. */
const RE_SHEET_NUMBER = /^([A-Z]{1,3})[\s\-_]?(\d{1,4})(?:\.(\d{1,2}))?$/;
/** A detail / section / elevation number inside a callout bubble: 1–2 digits or one letter. */
const RE_DETAIL_NUMBER = /^(\d{1,2}|[A-Z])$/;

/**
 * Canonical key for matching: upper-case, separators removed, a zero decimal dropped
 * ("E-300" / "E300" / "E 300" / "E-300.00" → "E300"; "A101.01" stays "A101.01"). Returns null for
 * anything that is not sheet-number shaped, so callers never index on prose.
 */
export function normaliseSheetNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = RE_SHEET_NUMBER.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const [, prefix, number, decimal] = match;
  const dec = decimal && /[1-9]/.test(decimal) ? `.${decimal}` : "";
  return `${prefix}${number}${dec}`;
}

/** Discipline prefix of a sheet key ("A101.01" → "A", "FA001" → "FA"); null when not a key. */
export function sheetPrefix(key: string | null | undefined): string | null {
  if (!key) return null;
  const match = /^([A-Z]{1,3})\d/.exec(key);
  return match ? match[1] : null;
}

export function isSheetNumberLike(text: string): boolean {
  return RE_SHEET_NUMBER.test(text.trim().toUpperCase());
}

export function isDetailNumberLike(text: string): boolean {
  return RE_DETAIL_NUMBER.test(text.trim().toUpperCase());
}

/** Detail number as written, upper-cased and without a leading zero ("03" → "3", "a" → "A"). */
export function normaliseDetailNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim().toUpperCase();
  if (!RE_DETAIL_NUMBER.test(text)) return null;
  return /^\d+$/.test(text) ? String(parseInt(text, 10)) : text;
}

/** "3/A-501" · "3 / A501" · "A/A-501" → { detail: "3", sheet: "A-501" }; null otherwise. */
export function parseDetailSlash(text: string): { detail: string; sheet: string } | null {
  const match = /^(\d{1,2}|[A-Z])\s*\/\s*([A-Z]{1,3}[\s\-_]?\d{1,4}(?:\.\d{1,2})?)$/.exec(text.trim().toUpperCase());
  if (!match) return null;
  const detail = normaliseDetailNumber(match[1]);
  return detail ? { detail, sheet: match[2] } : null;
}
