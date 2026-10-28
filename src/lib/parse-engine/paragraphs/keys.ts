/**
 * Paragraph key and block-header grammar (K34, K35; pure, client-safe: imports nothing, E-8).
 *
 * One grammar for every notes / spec / keynote-list reader. The legacy binders matched a key with
 * `^\s*\(?(\d{1,3})\s*[.):]` on the first word, so "2.5 MM" opened note 2 and "1:50" opened note 1
 * (K35), and their header test was case-insensitive, so "see note 4 …" and "Notes: provide shims"
 * opened a section (K34). Here:
 *
 * - a key is the WHOLE first token of a line, anchored at both ends: `1.` `(1)` `1)` `1:` are strong
 *   number keys; a bare `1` is a WEAK number key (the segmenter accepts it only in sequence and in the
 *   key column); `2.5` is never a number key. `A.` / `a)` / `(B)` are letter keys; `1.01` is a strong
 *   spec article, `2.3` a weak one; `K-01` / `EF-10.` / `A1` are tag keys;
 * - a notes block header is a whole UPPER-CASE line (no lower-case letter anywhere) that ends in NOTES,
 *   KEYNOTES, LEGEND, ABBREVIATIONS, SYMBOLS or SPECIFICATIONS, optionally followed by a continuation
 *   mark (`(CONT.)`, `CONT'D`, `CONTINUED`) and a colon; spec headers are `SECTION nn nn nn …`,
 *   `PART n …` and `END OF SECTION` (a title-case name after the number is allowed). A line that starts
 *   with a key is never a header. Whether a header-shaped line IS a header in context (an all-caps
 *   wrapped line ending in NOTES is not) is the segmenter's call: this grammar has no geometry.
 *
 * `keyNorm` is the comparison form used by `StructureIndexV1.keys` ("K-01" → "K01", "(4)" → "4",
 * "1.01" → "1.01"); `sectionNorm` is the `specSections` form ("08 71 00" → "087100").
 */

export type KeyClass = "number" | "upper" | "lower" | "article" | "tag";

export interface KeyMatch {
  /** The key as printed, without its punctuation: "4", "A", "a", "1.01", "K-01". */
  key: string;
  cls: KeyClass;
  /** Punctuated or hyphenated keys are strong; a bare `1` or `A1` is weak (needs sequence + column). */
  strong: boolean;
  /** Numeric value for sequence checks: the number, the letter's ordinal (A = 1), the article's hundredths, the tag's digits. */
  ordinal: number;
  /** For articles, the major part ("1.01" → 1); for tags, the letter prefix ("K-01" → "K"); else null. */
  group: string | null;
  /** The line text after the key token, trimmed. */
  rest: string;
}

const RE_NUMBER_STRONG = /^\(?(\d{1,3})[.):]$/;
const RE_NUMBER_WEAK = /^(\d{1,3})$/;
const RE_UPPER = /^\(?([A-Z])[.):]$/;
const RE_LOWER = /^\(?([a-z])[.):]$/;
const RE_ARTICLE_STRONG = /^(\d{1,2})\.(\d{2})\.?$/;
const RE_ARTICLE_WEAK = /^(\d{1,2})\.(\d)$/;
const RE_TAG = /^([A-Z]{1,3})(-?)(\d{1,3})([A-Z])?([.:)]?)$/;

/** Split off the first whitespace-delimited token of a line. */
function firstToken(line: string): { token: string; rest: string } | null {
  const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(line);
  if (!m) return null;
  return { token: m[1], rest: m[2].trim() };
}

/** The key that opens `line`, or null when its first token is not a key. */
export function matchKey(line: string): KeyMatch | null {
  const ft = firstToken(line);
  if (!ft) return null;
  const { token, rest } = ft;
  let m: RegExpExecArray | null;
  if ((m = RE_NUMBER_STRONG.exec(token))) {
    return { key: m[1], cls: "number", strong: true, ordinal: parseInt(m[1], 10), group: null, rest };
  }
  if ((m = RE_NUMBER_WEAK.exec(token))) {
    return { key: m[1], cls: "number", strong: false, ordinal: parseInt(m[1], 10), group: null, rest };
  }
  if ((m = RE_UPPER.exec(token))) {
    return { key: m[1], cls: "upper", strong: true, ordinal: m[1].charCodeAt(0) - 64, group: null, rest };
  }
  if ((m = RE_LOWER.exec(token))) {
    return { key: m[1], cls: "lower", strong: true, ordinal: m[1].charCodeAt(0) - 96, group: null, rest };
  }
  if ((m = RE_ARTICLE_STRONG.exec(token))) {
    return { key: `${m[1]}.${m[2]}`, cls: "article", strong: true, ordinal: parseInt(m[1], 10) * 100 + parseInt(m[2], 10), group: m[1], rest };
  }
  if ((m = RE_ARTICLE_WEAK.exec(token))) {
    return { key: `${m[1]}.${m[2]}`, cls: "article", strong: false, ordinal: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) * 10, group: m[1], rest };
  }
  if ((m = RE_TAG.exec(token))) {
    const key = `${m[1]}${m[2]}${m[3]}${m[4] ?? ""}`;
    return { key, cls: "tag", strong: m[2] === "-" || m[5] !== "", ordinal: parseInt(m[3], 10), group: m[1], rest };
  }
  return null;
}

/** True when the line opens with a strong key (the §2.1 "keys counted from containedText" rule). */
export function isKeyedLine(line: string): boolean {
  const k = matchKey(line);
  return k !== null && k.strong;
}

/** Number of lines (a string with newlines, or an array) that open with a strong key. */
export function countKeyedLines(text: string | readonly string[]): number {
  const lines = typeof text === "string" ? text.split(/\r?\n/) : text;
  let n = 0;
  for (const l of lines) if (isKeyedLine(l)) n++;
  return n;
}

/**
 * Comparison form of a printed key: upper-case, separators removed, leading zeros dropped from a pure
 * number ("(04)" → "4"), kept inside a tag ("K-01" → "K01") and an article ("1.01" stays).
 */
export function normaliseKey(key: string | null | undefined): string {
  if (!key) return "";
  const t = key.trim().toUpperCase().replace(/^\(|[.):]+$/g, "").replace(/[\s\-_]/g, "");
  if (/^\d+$/.test(t)) return String(parseInt(t, 10));
  return t;
}

/** `specSections` form of a section number: digits only ("08 71 00" → "087100", "09 29 00.13" → "09290013"). */
export function sectionNorm(section: string | null | undefined): string {
  if (!section) return "";
  return section.replace(/\D/g, "");
}

/** Printed form of a normalised section: "087100" → "08 71 00", "09290013" → "09 29 00.13". */
export function formatSection(norm: string): string {
  const d = norm.replace(/\D/g, "");
  if (d.length < 6) return d;
  const head = `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 6)}`;
  return d.length > 6 ? `${head}.${d.slice(6)}` : head;
}

// ── block headers ───────────────────────────────────────────────────────────────────────────────

export type HeaderKind = "notes" | "legend" | "spec-section" | "spec-part" | "end-of-section";

export interface HeaderMatch {
  kind: HeaderKind;
  /** The header as printed (trimmed). */
  header: string;
  /** Comparison form: upper-case words, continuation mark and trailing colon removed. */
  headerNorm: string;
  /** `(CONT.)`, `CONT'D` or `CONTINUED` was present (§1.7 rule 5). */
  continued: boolean;
  /** For `spec-section`: the section number as printed with spaces ("08 71 00"). */
  section?: string;
  /** For `spec-part`: the part number. */
  part?: number;
}

const RE_CONT = /\s*(?:\(\s*CONT(?:'D|D|\.|INUED)?\.?\s*\)|[-–—]?\s*(?:CONT(?:'D|D)\.?|CONTINUED))\s*:?\s*$/;
const RE_NOTES_HEADER =
  /^(?:[A-Z][A-Z0-9&/'’.\-]*\s+){0,6}(?:(?:GENERAL\s+)?NOTES?|KEY\s?NOTES?|LEGEND|ABBREVIATIONS?|SYMBOLS?|SPECIFICATIONS?)$/;
const RE_LEGEND_HEADER = /(?:^|\s)(?:LEGEND|ABBREVIATIONS?|SYMBOLS?)$/;
const RE_SPEC_SECTION = /^SECTION\s+(\d{2})\s?(\d{2})\s?(\d{2})(?:\.(\d{2}))?\b/;
const RE_SPEC_PART = /^PART\s+(\d)\b/;
/** A mixed-case PART line is a header only as `PART n - Title` / `PART n Title Case` ("PART 1 of the work …" is prose). */
const RE_SPEC_PART_MIXED = /^PART\s+\d(?:\s*[-–—.:]\s*[A-Z]\S*|\s+[A-Z]\S*)(?:\s+(?:[A-Z]\S*|and|of|for|the|to|in|&))*\s*$/;
const RE_END_OF_SECTION = /^END\s+OF\s+SECTION\b/;
const MAX_HEADER_CHARS = 60;

/** Comparison form of a header: upper-case, continuation mark and trailing colon dropped, punctuation collapsed to spaces. */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toUpperCase()
    .replace(RE_CONT, "")
    .replace(/:\s*$/, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** The block header `line` is, or null. Case-sensitive: a header is printed in capitals (K34). */
export function matchHeader(line: string): HeaderMatch | null {
  const header = line.trim();
  if (header === "" || header.length > MAX_HEADER_CHARS) return null;
  if (matchKey(header)) return null; // "4. NOTES ARE …" is a note, never a header
  const lower = /[a-z]/.test(header);

  // spec headers first: their keywords are matched upper-case, and a title-case name after the number
  // ("SECTION 08 71 00 - Door Hardware", "PART 1 - General") is normal in a project manual (VERIFY MED-5)
  let m: RegExpExecArray | null;
  if ((m = RE_SPEC_SECTION.exec(header))) {
    const section = `${m[1]} ${m[2]} ${m[3]}${m[4] ? `.${m[4]}` : ""}`;
    return { kind: "spec-section", header, headerNorm: normaliseHeader(header), continued: RE_CONT.test(header), section };
  }
  if (RE_END_OF_SECTION.test(header)) {
    return { kind: "end-of-section", header, headerNorm: normaliseHeader(header), continued: false };
  }
  if ((m = RE_SPEC_PART.exec(header)) && (!lower || RE_SPEC_PART_MIXED.test(header))) {
    return { kind: "spec-part", header, headerNorm: normaliseHeader(header), continued: RE_CONT.test(header), part: parseInt(m[1], 10) };
  }
  if (lower) return null; // K34: "see note 4 …", "Notes: provide shims" (the notes grammar is upper-case only)
  const continued = RE_CONT.test(header);
  const core = header.replace(RE_CONT, "").replace(/:\s*$/, "").trim();
  if (!RE_NOTES_HEADER.test(core)) return null;
  const kind: HeaderKind = RE_LEGEND_HEADER.test(core) ? "legend" : "notes";
  return { kind, header, headerNorm: normaliseHeader(header), continued };
}

/** §1.7 rule 1 / 4c: a notes block "headed GENERAL NOTES" — its normalised header contains GENERAL. */
export function isGeneralNotesHeader(headerNorm: string | null | undefined): boolean {
  return typeof headerNorm === "string" && /\bGENERAL\b/.test(headerNorm) && /\bNOTES?\b/.test(headerNorm);
}
