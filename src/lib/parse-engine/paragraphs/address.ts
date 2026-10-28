/**
 * Sheet keys and paragraph addresses (K67, C2-M8; pure, client-safe: imports only `../types`, E-8).
 *
 * `sheetKey` is the ONE comparison key for a drawing number in the engine. It is the knowledge-graph
 * `normaliseSheetNumber` grammar widened for the three shapes K67 found rejected on real sets — a
 * suffix letter (`A-101A`), a dot separator (`A.101`) and a 4-letter prefix (`ABCD-101`) — and gives
 * the same key as the KG for every input the KG accepts (asserted by a test, so the two never drift
 * unnoticed). It is re-implemented rather than imported because `knowledge-graph/sheet-number.ts`
 * is outside the client-safe subset.
 *
 * ⚠ `shape-ensemble/text-rules.ts` exports another `sheetKey` (strip every non-alphanumeric: "A-101.00"
 * → "A10100"), which the evidence loader uses for `EnginePageEvidence.sheet.key`. This module's key for
 * the same string is "A101". The resolver compares keys it computed itself on both sides, so it never
 * mixes the two; a consumer that joins `sheet.key` to this key must convert (see WP-3.C report).
 *
 * An address is NOT stored anywhere: it is computed at read time from the page's CURRENT drawing number
 * (C2-M8), so a later rename never leaves a stale address.
 */

import type { ParagraphAddress } from "../types";

/** Sheet number as written: A-101, A101, A 101, A.101, A-101A, E-300.00, FA-001, T001.04, ABCD-101. */
const RE_SHEET_NUMBER = /^([A-Z]{1,4})[\s\-_.]?(\d{1,4})([A-Z]{1,2})?(?:\.(\d{1,2}))?$/;
/** 4-letter words that precede a number in note prose and are never a discipline prefix. */
const PROSE_PREFIXES: ReadonlySet<string> = new Set(["NOTE", "PART", "TYPE", "ROOM", "DOOR", "PAGE", "ITEM", "UNIT", "AREA", "ZONE", "STEP", "CASE", "MARK", "SIZE", "WALL", "BLDG", "DWGS"]);

/**
 * Canonical key: upper-case, separators removed, a zero decimal dropped ("A-101.00" / "A101" / "a 101" →
 * "A101"; "A-101A" → "A101A"; "A.101" → "A101"; "T001.04" → "T001.04"). Null for anything that is not
 * sheet-number shaped, so callers never index on prose.
 */
export function sheetKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = RE_SHEET_NUMBER.exec(raw.trim().toUpperCase());
  if (!m) return null;
  const [, prefix, number, suffix, decimal] = m;
  // a 4-letter prefix (K67) is a sheet only with ≥ 3 digits and when it is not a common word: "NOTE 4",
  // "TYPE 12", "ROOM 101" are prose (VERIFY LOW-1). 1–3 letters keep the KG grammar exactly.
  if (prefix.length === 4 && (number.length < 3 || PROSE_PREFIXES.has(prefix))) return null;
  const dec = decimal && /[1-9]/.test(decimal) ? `.${decimal}` : "";
  return `${prefix}${number}${suffix ?? ""}${dec}`;
}

/** Discipline prefix of a key ("A101.01" → "A", "FA001" → "FA"); null when `key` is not a key. */
export function sheetPrefix(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = /^([A-Z]{1,4})\d/.exec(key);
  return m ? m[1] : null;
}

/**
 * Position of a key within its discipline, for "nearest sheet" ordering: the number plus the decimal as
 * a fraction, plus a small step per suffix letter ("A101" → 101, "A101A" → 101.001, "A101.04" → 101.04).
 */
export function sheetOrdinal(key: string | null | undefined): number | null {
  if (!key) return null;
  const m = /^[A-Z]{1,4}(\d{1,4})([A-Z]{1,2})?(?:\.(\d{1,2}))?$/.exec(key);
  if (!m) return null;
  const [, number, suffix, decimal] = m;
  let v = parseInt(number, 10);
  if (decimal) v += parseInt(decimal, 10) / 100;
  if (suffix) v += (suffix.charCodeAt(0) - 64) / 1000;
  return v;
}

/** |ordinal(a) − ordinal(b)| when both are keys of the same discipline; null otherwise. */
export function sheetDistance(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = sheetPrefix(a);
  const pb = sheetPrefix(b);
  if (pa === null || pb === null || pa !== pb) return null;
  const oa = sheetOrdinal(a);
  const ob = sheetOrdinal(b);
  return oa === null || ob === null ? null : Math.abs(oa - ob);
}

export interface ParagraphAddressInput {
  planset: string;
  page: number;
  /** The page's CURRENT drawing number (raw); null when it has none. */
  drawingNumber: string | null | undefined;
  regionId: string;
  blockHeader: string | null;
  keyPath: readonly string[];
  targetId: string;
}

/** The address of a paragraph: `sheet` is the sheet key, or `p<page>` for a page with no readable number. */
export function paragraphAddress(a: ParagraphAddressInput): ParagraphAddress {
  return {
    planset: a.planset,
    sheet: sheetKey(a.drawingNumber) ?? `p${a.page}`,
    page: a.page,
    regionId: a.regionId,
    blockHeader: a.blockHeader,
    keyPath: [...a.keyPath],
    targetId: a.targetId,
  };
}

export interface FormatAddressOptions {
  /** The sheet as the user knows it (the raw drawing number); default the address's key. */
  sheetLabel?: string | null;
  /** Spec section ("08 71 00"): the display becomes `<section> › <keyPath joined with ".">`. */
  specSection?: string | null;
}

/** Display form: "A-501 › ELECTRICAL NOTES › 3"; spec "08 71 00 › 2.3.A"; an unkeyed paragraph shows "¶". */
export function formatParagraphAddress(a: ParagraphAddress, opts: FormatAddressOptions = {}): string {
  const path = a.keyPath.length > 0 ? a.keyPath.join(".") : "¶";
  if (opts.specSection) return `${opts.specSection} › ${path}`;
  const sheet = opts.sheetLabel && opts.sheetLabel.trim() !== "" ? opts.sheetLabel.trim() : a.sheet;
  return a.blockHeader ? `${sheet} › ${a.blockHeader} › ${path}` : `${sheet} › ${path}`;
}

/** Machine form, stable for links: "para:A501/ELECTRICAL NOTES/3" ("/" and "%" in parts are escaped). */
export function paragraphAddressId(a: ParagraphAddress): string {
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\//g, "%2F");
  const parts = [a.sheet, a.blockHeader ?? "", ...a.keyPath].map(esc);
  return `para:${parts.join("/")}`;
}
