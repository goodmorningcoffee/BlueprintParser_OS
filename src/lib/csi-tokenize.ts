/**
 * csi-tokenize.ts — the ONE tokenizer for CSI v2 (PLAN §5.4), shared by the KB
 * builder (eval/, bundled with --alias:@=./src) and the runtime matcher.
 *
 * Client-safe: no fs, no node imports, no runtime dependencies (one type-only import).
 *
 * Rules, in order, for each whitespace-separated word:
 *   1. split on '-', '/' (and the Unicode hyphen/dash range U+2010–U+2015);
 *   2. per piece: NFKD + strip diacritics, lowercase, strip every non [a-z0-9] char;
 *   3. drop the piece if it is a stop word (checked BEFORE folding), all digits, or 1 char;
 *   4. fold plurals (`foldPlural`), then word forms by `FOLD_MAP` (`canonToken`).
 *
 * There is NO abbreviation expansion. `GYP` stays `gyp`; ALL-CAPS 2–5 letter tokens are
 * resolved against `csi_terms.tsv` rows downstream (S2/S3), never here.
 *
 * Printed codes (`09 29 00`, `092900`, `R-13`) are NOT the tokenizer's job: digits are
 * dropped here by design, and printed codes / `R-\d+` style rows are detected by a separate
 * regex over the RAW unit text (S3, `KbPattern.kind === 'regex'`). So `R-13 INSULATION`
 * tokenizes to `insulate` alone, and the R-value only ever reaches the engine via regex.
 */

import type { BboxLTWH } from "@/types";

/** One canonical token (IMPLEMENTATION §I, amended by §IV E1).
 *  - `pos` indexes the ORIGINAL whitespace-separated word sequence of the input, so a unit
 *    built as `line.words.join(' ')` maps `pos` straight back to a Textract word and its
 *    bbox. A word split on '-' or '/' yields several tokens sharing one `pos`; dropped
 *    pieces leave gaps.
 *  - `start`/`end` are UTF-16 offsets into the exact `text` passed to `tokenize` (not
 *    trimmed), end-exclusive, with `text.slice(start, end) === raw`. A regex hit `[a, b)`
 *    on the raw text covers the tokens with `start < b && end > a` (E7).
 *  - `boundaryBefore` marks a unit-internal boundary between the PREVIOUS token and this
 *    one: some `[.;:(]` lies between the previous token's last letter/digit and this
 *    token's first, other than the '.' ending a previous `abbrevDot` token and a '.' between
 *    two digits (`2.5`). Never set on the first token. A span over tokens `[a..b]` crosses
 *    a boundary iff some token in `a+1..b` has it (E5).
 *  - `bbox` is never set by `tokenize`; callers that know the word geometry attach it. */
export interface Tok {
  t: string;
  raw: string;
  pos: number;
  start: number;
  end: number;
  bbox?: BboxLTWH;
  abbrevDot?: boolean;
  boundaryBefore?: boolean;
}

/** English function words only. Deliberately ABSENT (asserted by test): `not`, `no`,
 *  `others`, `other`, `existing`, `all`, `any`, `new`, `see` — negation, scope and
 *  boilerplate words are kept as tokens and handled by the floor/boilerplate lists
 *  (PLAN §5.5) or the negation regex (PLAN §6.6). */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "nor", "but", "of", "in", "on", "at", "to", "for",
  "from", "by", "with", "into", "onto", "as", "per", "via", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "this", "that", "these", "those", "which", "who",
  "whom", "whose", "what", "than", "then", "there", "their", "they", "them", "he",
  "she", "we", "you", "me", "my", "our", "your", "his", "her", "if", "so", "do", "does",
  "did", "has", "have", "had", "will", "shall", "would", "should", "can", "could",
  "may", "might", "must", "also", "etc",
]);

/** Words that look plural but are not (left untouched by `foldPlural`). */
const PLURAL_INVARIANT: ReadonlySet<string> = new Set([
  "glass", "gas", "bus", "canvas", "brass", "truss", "series", "species", "lens",
  "chassis",
  // S1.1 / IMPLEMENTATION E12 D8 (measured: EIFS folded to "eif").
  "eifs", "asbestos", "atlas", "plexiglas",
]);

/** Plurals the suffix rules would get wrong (each pinned to land on its singular's token). */
const PLURAL_IRREGULAR: Readonly<Record<string, string>> = {
  gases: "gas", buses: "bus", busses: "bus", canvases: "canvas", lenses: "lens",
  shelves: "shelf", indices: "index", leaves: "leaf", niches: "niche", axes: "axis",
};

/** Own-property lookup: plain-object maps must not answer `constructor`, `toString`, … */
function lookup(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Word-form folds (PLAN §5.4's explicit list, extended to common MasterFormat -ing/-ed/
 *  -ion nouns). Applied by `canonToken` only when the stem is in the supplied vocabulary;
 *  with no vocabulary they are applied unconditionally — which is how the KB builder calls it
 *  (owner ruling 2026-10-20, kb-v2.4: fold always), so no key is ever a KB token.
 *  REMOVED 2026-10-20 (kb-v2.4): `cooling: cool` — under fold-always it only renamed the token
 *  (no source word tokenizes to `cool`) and would have let a bare COOL match every cooling pattern.
 *  REMOVED by the S2 term/fold review (2026-10-20, measured against MF2018 titles) because the
 *  fold merges two trades: framing/framed (METAL FRAMING = 08 12 00 "Metal Frames"), cleaning
 *  (13 21 13 Clean Rooms), coated (Coat Racks, Tack Coats), wiring (Welded Wire, Wire Rope),
 *  glazed (08 80 Glazing), insulated/insulating (adjectives of other products), cured/curing
 *  (Cured-in-Place vs Concrete Curing), welded/welding (Welded Wire vs Welding gases). Those
 *  words now stay their own tokens. */
export const FOLD_MAP: Readonly<Record<string, string>> = {
  anchored: "anchor", anchoring: "anchor",
  carpeting: "carpet",
  caulking: "caulk",
  coating: "coat",
  dampproofing: "dampproof",
  demolishing: "demolish", demolition: "demolish",
  fencing: "fence",
  finished: "finish", finishing: "finish",
  firestopping: "firestop",
  fireproofing: "fireproof",
  grouted: "grout", grouting: "grout",
  heating: "heat",
  insulation: "insulate",
  lighting: "light",
  mounted: "mount", mounting: "mount",
  painted: "paint", painting: "paint",
  paneled: "panel", paneling: "panel", panelling: "panel",
  piping: "pipe",
  plastered: "plaster", plastering: "plaster",
  reinforced: "reinforce", reinforcement: "reinforce", reinforcing: "reinforce",
  surfaced: "surface", surfacing: "surface",
  testing: "test",
  tiled: "tile", tiling: "tile",
  ventilating: "ventilate", ventilation: "ventilate",
  waterproofing: "waterproof",
};

/** Exceptions: the surface form is KEPT as the token (MasterFormat names these trades by
 *  the -ing noun), and the stem is exposed here so the KB builder can index both
 *  (see `indexForms`). */
export const FOLD_EXCEPTIONS: Readonly<Record<string, string>> = {
  glazing: "glaze",
  roofing: "roof",
  flashing: "flash",
  siding: "side",
};

/** Normalized forms of words allowed to be INSERTED inside a pattern's match window
 *  (e.g. `GYPSUM WALL BOARD`). Keys are the surface spellings; values are what
 *  `tokenize(key)` joins to with single spaces (pinned by the whitelist-parity test). */
export const INSERT_WHITELIST: Readonly<Record<string, string>> = {
  wall: "wall",
  panel: "panel",
  sheet: "sheet",
  type: "type",
  "fire-rated": "fire rated",
  "moisture-resistant": "moisture resistant",
};

const PIECE_SPLIT = /[-/‐-―]/;
// Two shapes: `GYP.` / `MTL.` (ALL-CAPS 2–5 letters + '.') and the dotted drawing forms
// `N.I.C.` / `O.C.` / `A.F.F.` / `U.L.` (2–5 single capitals each followed by '.').
const ABBREV_DOT = /^[^A-Za-z0-9]*(?:[A-Z]{2,5}\.|(?:[A-Z]\.){2,5})[^A-Za-z0-9]*$/;

/** True when a raw piece is an ALL-CAPS 2–5 letter token followed directly by '.'
 *  (`GYP.`, `BD.`, `(MTL.`) or a dotted abbreviation (`N.I.C.`, `O.C.`). Shape only:
 *  whether it IS a known abbreviation is decided against `csi_terms.tsv` downstream, or by
 *  the `known` set passed to `tokenize` / `splitTextUnits`. */
export function isAbbrevDot(raw: string): boolean {
  return ABBREV_DOT.test(raw);
}

/** Lowercase, strip diacritics, strip every non-alphanumeric character. */
export function normalizePiece(piece: string): string {
  return piece
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Plural fold: `ies→y`, `(sses|xes|ches|shes)→-es`, else a trailing `s` unless the word
 *  ends `ss`/`us`/`is`. Words under 4 chars and `PLURAL_INVARIANT` are left alone. */
export function foldPlural(w: string): string {
  if (PLURAL_INVARIANT.has(w)) return w;
  const irregular = lookup(PLURAL_IRREGULAR, w);
  if (irregular) return irregular;
  if (w.length < 4 || !w.endsWith("s")) return w;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(?:sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (/(?:ss|us|is)$/.test(w)) return w;
  return w.slice(0, -1);
}

/** Canonical form of one piece (no whitespace, '-' or '/'): normalize, fold plural, then
 *  apply `FOLD_MAP` when its stem is in `vocab` (always, when `vocab` is omitted).
 *  The fold depends on `vocab` (`Heating` → `heat` with no vocab, `heating` under a vocab
 *  lacking `heat`). The KB builder omits it; the runtime may pass the KB token set and still
 *  match identically, because a fold it skips maps an out-of-vocabulary word to another
 *  out-of-vocabulary word (proof: eval/csi/build-kb-v2.ts §3).
 *  `FOLD_EXCEPTIONS` surface forms are returned unchanged. Returns '' when nothing
 *  alphanumeric is left. Does NOT apply the stop/numeric/length drops — `tokenize` does. */
export function canonToken(word: string, vocab?: ReadonlySet<string>): string {
  const plain = foldPlural(normalizePiece(word));
  if (Object.hasOwn(FOLD_EXCEPTIONS, plain)) return plain;
  const stem = lookup(FOLD_MAP, plain);
  if (stem && (!vocab || vocab.has(stem))) return stem;
  return plain;
}

/** Every form a canonical token should be INDEXED under: itself, plus its stem when it is
 *  a `FOLD_EXCEPTIONS` surface form (`glazing` → [`glazing`, `glaze`]). */
export function indexForms(t: string): string[] {
  const stem = lookup(FOLD_EXCEPTIONS, t);
  return stem ? [t, stem] : [t];
}

function tooShortOrNumeric(t: string): boolean {
  return t.length < 2 || /^\d+$/.test(t);
}

/** A char that survives `normalizePiece` (so it is part of some token's text). */
function isCoreChar(c: string): boolean {
  return normalizePiece(c) !== "";
}

/** Offsets of the first and last core char of `text.slice(start, end)`, as [lo, hi). */
function coreRange(text: string, start: number, end: number): [number, number] {
  let lo = start;
  while (lo < end && !isCoreChar(text[lo])) lo++;
  let hi = end;
  while (hi > lo && !isCoreChar(text[hi - 1])) hi--;
  return [lo, hi];
}

/** True when `text[from, to)` holds a unit-internal boundary char (`[.;:(]`), ignoring a
 *  '.' between two digits (`2.5`) and, when `skipLeadDot`, a '.' at `from` itself. */
function hasBoundary(text: string, from: number, to: number, skipLeadDot: boolean): boolean {
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "." && skipLeadDot && i === from) continue;
    if (c === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
    if (c === "." || c === ";" || c === ":" || c === "(") return true;
  }
  return false;
}

/** Tokenize a unit's text. Deterministic and pure.
 *  `known` (optional, lowercase, dots stripped — `gyp`, `nic`, `oc`): when given, a '.'
 *  exempts the following boundary only after a KNOWN abbreviation (PLAN §5.4); without it
 *  the exemption is shape-only, so `PAINT.` is exempt exactly like `GYP.`. Same contract
 *  as `splitTextUnits`. `abbrevDot` on the Tok stays shape-only either way. */
export function tokenize(text: string, vocab?: ReadonlySet<string>, known?: ReadonlySet<string>): Tok[] {
  const out: Tok[] = [];
  let prevCoreEnd = -1;
  let prevAbbrevDot = false;
  let pos = 0;
  for (const m of text.matchAll(/\S+/g)) {
    let start = m.index;
    for (const raw of m[0].split(PIECE_SPLIT)) {
      const end = start + raw.length;
      const pieceStart = start;
      start = end + 1; // every PIECE_SPLIT separator is one UTF-16 unit
      const normalized = normalizePiece(raw);
      if (tooShortOrNumeric(normalized) || STOP_WORDS.has(normalized)) continue;
      const t = canonToken(raw, vocab);
      if (tooShortOrNumeric(t)) continue;
      const tok: Tok = { t, raw, pos, start: pieceStart, end };
      if (isAbbrevDot(raw)) tok.abbrevDot = true;
      const [coreStart, coreEnd] = coreRange(text, pieceStart, end);
      if (prevCoreEnd >= 0 && hasBoundary(text, prevCoreEnd, coreStart, prevAbbrevDot)) {
        tok.boundaryBefore = true;
      }
      prevCoreEnd = coreEnd;
      prevAbbrevDot = tok.abbrevDot === true && (!known || known.has(normalized));
      out.push(tok);
    }
    pos++;
  }
  return out;
}

/** True when the '.' at `text[dot]` directly follows an ALL-CAPS 2–5 letter token that
 *  starts at a word boundary (PLAN §6.1's `(?<!\b[A-Z]{2,5})`), and — when `known` is
 *  given — that token's lowercase form is a known abbreviation. */
function abbrevDotAt(text: string, dot: number, known?: ReadonlySet<string>): boolean {
  // `GYP` or the dotted form `N.I.C` (the inner dots never precede whitespace, so only the
  // last one reaches here). Look back 12 chars: enough for `(A.F.F` plus a boundary char.
  const m = /(?:^|[^A-Za-z0-9_.])((?:[A-Z]\.){1,4}[A-Z]|[A-Z]{2,5})$/.exec(text.slice(Math.max(0, dot - 12), dot));
  if (!m) return false;
  return !known || known.has(m[1].replace(/\./g, "").toLowerCase());
}

/**
 * Split free text into matching units (PLAN §6.1): on newline, on ';', and on a '.'
 * followed by whitespace — UNLESS that '.' directly follows an ALL-CAPS 2–5 letter token.
 * Units are trimmed; empty units are dropped.
 *
 * `known` (optional, lowercase): restricts the exemption to KNOWN abbreviations (PLAN §5.4:
 * "a '.' directly after a known abbreviation is not a boundary"), e.g. the `csi_terms.tsv`
 * abbrev rows. Without it the rule is shape-only, exactly PLAN §6.1's regex — which also
 * exempts ordinary short ALL-CAPS words (`NOTE.`), so ALL-CAPS sentence ends ending in a
 * 2–5 letter word do NOT split. Pass `known` wherever sentence boundaries matter.
 */
export function splitTextUnits(text: string, known?: ReadonlySet<string>): string[] {
  const units: string[] = [];
  const push = (s: string) => {
    const u = s.trim();
    if (u) units.push(u);
  };
  const boundary = /\n|;|\.(?=\s)/g;
  let start = 0;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    if (m[0] === "." && abbrevDotAt(text, m.index, known)) continue;
    push(text.slice(start, m.index));
    start = m.index + 1;
  }
  push(text.slice(start));
  return units;
}
