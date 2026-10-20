/**
 * mf-parse.ts — MasterFormat 2018 PDF → build/mf-parsed.json (CSI tagger v2, step S1).
 *
 * Node + pdfjs port of `gitignore/projects/csi_tagger_v2/tools/mf_parse_prototype.py`
 * (pypdf). The block grammar (Includes / Alternate Terms / See / Notes) is the
 * prototype's; the keyword-index head rule is NOT — pypdf lost indentation, and the
 * prototype mis-headed ~23% of sub-entries. Here indentation comes from pdfjs x.
 *
 * ── GEOMETRY (measured on the 714-page PDF, 2026-10-19) ──
 * - Master list pages are ONE column: code at x≈55/72, level-5 code indented ~13 pt,
 *   title at x≈145/185, explanation blocks at x≈230/247. Some side notes ("May be used
 *   as Division level Section title.") sit at x≈387, right of the page midline.
 * - The keyword index is THREE columns, not two (column starts 72/246/419 on odd pages,
 *   55/229/402 on even). So `x < pageWidth/2` would merge columns 1 and 2. Column
 *   starts are therefore read from the x of the code items on each page (a start opens
 *   when a code x is > 100 pt right of the previous start); a page with no code items
 *   falls back to the pageWidth/2 split.
 * - Within an index column, text sits at three offsets from the column start:
 *   0 (codes, abbreviation rows, `… X - see Y` lines, letter bars), 36 (head level),
 *   47 (sub-entry level). A wrapped line repeats the text x of the line it continues.
 *
 * ── HEAD RULE (PLAN §5.1) ──
 * A line is a HEAD if it has no code, OR has a code and the following lines are
 * indented deeper (textX > line.textX + 3 pt). Sub-entries attach to the nearest head
 * above. DEFAULT (`carryHeads: true`, S1 decision): the open head CARRIES across column
 * and page breaks, because the printed flow continues there (see IndexOptions). The CLI
 * flag `--reset-heads` (`carryHeads: false`) is PLAN §5.1 as literally written — the head
 * resets at every column and page break. In either mode a sub-level entry with no head is
 * counted (`report.headless`) and dropped.
 *
 * ── TITLES (PLAN §5.2, parse half) ──
 * Over-grabbed header text is cut at the first match of TITLE_STRIP (truncation, not
 * substring removal: the junk is always trailing); adjacent duplicate words are removed;
 * titles starting `for|see` are blanked and listed in `report.rejectedTitles` (S2
 * substitutes the TSV title). Reconciliation with the TSV is S2, not here.
 *
 * Usage (esbuild-bundle convention, IMPLEMENTATION.md):
 *   npx esbuild eval/csi/mf-parse.ts --bundle --platform=node --target=node20 \
 *     --alias:@=./src --external:pg-native --outfile=build/csi-mf-parse.js
 *   node build/csi-mf-parse.js [pdfPath] [outPath]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_PDF = "/workspaces/projects/gitignore/csi_masterformat.pdf";
export const DEFAULT_OUT = "build/mf-parsed.json";
const PDFJS_ABS =
  "/workspaces/projects/BlueprintParser_OS_july10_part6_refactor/blueprintparser_2/node_modules/pdfjs-dist/legacy/build/pdf.mjs";

// ───────────────────────────── types ─────────────────────────────

export interface PdfItem { str: string; x: number; y: number; h: number; w?: number }
export interface PdfPage { page: number; width: number; height: number; items: PdfItem[] }

export interface Line {
  page: number;
  col: number;
  colStart: number;
  x: number;              // x of the first non-blank item
  y: number;
  h: number;
  text: string;           // whitespace-collapsed
  code: string | null;    // leading 'NN NN NN' / 'NN NN NN.NN'
  body: string;           // text after the code (== text when no code)
  textX: number;          // x where `body` starts
  right?: number;         // right edge (max x+w); only when every item has a width
  firstWordW?: number;    // estimated width of the first word of `body` (ditto)
}

export interface MasterEntry {
  code: string;
  title: string;
  level: 2 | 3 | 4 | 5;
  includes: string[];
  altTerms: string[];
  see: { code: string; text: string }[];
  notes: string[];
}
export interface IndexEntry { code: string; text: string; head: string | null; phrase: string; page: number }
export interface AbbrevRow { abbr: string; expansion: string }
export interface Synonym { from: string; to: string }

export interface MfReport {
  overGrabTitles: number;
  dupWords: number;
  rejectedTitles: { code: string; title: string }[];
  headless: number;
  danglingIndexCodes: number;
  danglingSee: number;
  splitWordArtifacts: number;
  unassigned: number;
}
export interface MfParsed {
  pages: number;
  master: MasterEntry[];
  index: IndexEntry[];
  abbrevRows: AbbrevRow[];
  synonyms: Synonym[];
  report: MfReport;
}

// ───────────────────────────── patterns ─────────────────────────────

const CODE = String.raw`\d\d \d\d \d\d(?:\.\d\d)?`;
export const CODE_LINE_RE = new RegExp(String.raw`^(${CODE})\s+(\S.*)$`);
const CODE_ONLY_RE = new RegExp(String.raw`^(${CODE})$`);
/** Four index rows print a code with a space missing ("09 0325"); read them canonically. */
const LOOSE_CODE_LINE_RE = /^(\d\d) ?(\d\d) ?(\d\d)((?:\.\d\d)?)\s+(\S.*)$/;
const LOOSE_CODE_ONLY_RE = /^\d\d ?\d\d ?\d\d(?:\.\d\d)?$/;
/** The item holding the code; a range row prints "45 45 10 to 45 46 99" as one item. */
const CODE_ITEM_RE = /^\d\d ?\d\d ?\d\d(?:\.\d\d)?(?: (?:to|through) \d\d \d\d \d\d(?:\.\d\d)?)?$/;
export const MASTER_PAGE_MARK = "Master List of Numbers, Titles, and Explanations";
export const INDEX_PAGE_RE = /Keyword Index/;
const LEVEL2_MARK_RE = /^Level 2 Numbers? and Titles$/;

/** PLAN §5.2 strip regex. A title is cut at its first match. */
export const TITLE_STRIP_RE =
  /Level \d Numbers|Numbers and Titles|May be used as Division|See Also:.*|Reserved for Future.*|D ?IVISION|N ?UMBER/;
export const REJECT_TITLE_RE = /^(for|see)\b/i;

/** Page furniture on master-list pages (prototype `hdr_noise`). */
const MASTER_NOISE_RE =
  /^(D ?IVISION \d\d\b.*|N ?UMBER T ?ITLE E ?XPLANATION.*|Master List of Numbers, Titles, and Explanations.*|\d+ Master List.*|\d+)$/;
/** The column header "N UMBER  TITLE  EXPLANATION" heads every master page, its three words
 *  set > SEG_GAP apart (x 72/162/247 or 55/145/231). `splitAtGaps` therefore yields them as
 *  three one-word lines that MASTER_NOISE_RE (whole header only) never sees; before S1.1 they
 *  were appended to the open block across the page break (measured: 9 altTerms, 42 includes,
 *  4 notes, 129 see texts). Dropped as standalone lines, and cut off a block line's tail if one
 *  is ever glued on (0 measured). Case-sensitive: block prose never prints these in caps. */
export const HEADER_FRAGMENT_RE = /^(N ?UMBER|T ?ITLE|E ?XPLANATION)$/;
export const HEADER_TAIL_RE = /\s+(?:N ?UMBER|T ?ITLE|E ?XPLANATION)(?:\s+(?:N ?UMBER|T ?ITLE|E ?XPLANATION))*$/;
/** Header strings that may never extend a title (prototype's `Level \\d` was a dead escape). */
const TITLE_HEADER_RE = /^(D ?IVISION|N ?UMBER|Master\b|Level \d)/;
const BLOCK_RE = /^(Includes|Alternate Terms\/Abbreviations|See Also|See|Notes|May Include|Excludes)\s*:\s*(.*)$/;
const RANGE_RE = new RegExp(String.raw`^(?:to|through) ${CODE}\s+([A-Z].*)$`);
const SEE_CONT_RE = new RegExp(String.raw`^(${CODE})\s+(.*)$`);

const INDEX_NOISE_RE = /^(\d+|Keyword Index|\d+ Keyword Index|Keyword Index \d+|[A-Z]_{3,}|KEYWORD INDEX)$/;
/** PLAN's /^[A-Z]{2,6}\s/ plus slash/digit forms the index also prints at the code x
 *  (AS/RS, CSU/DSU, I/O, ICU/CCU, IF/RF, I/P, V/P, T1 — 8 rows measured). */
const ABBREV_RE = /^([A-Z]{2,6}|[A-Z]{1,3}\/[A-Z]{1,3}|[A-Z]\d)\s+(\S.*)$/;
const SEE_SPLIT_RE = /\s+[-–]\s*see\b\s*/i;
const LEADER_RE = /^[….·\s]{2,}/;
const XX_RE = /^XX \d\d \d\d\b/;

// ───────────────────────────── geometry → lines ─────────────────────────────

const Y_TOL = 2;          // items within 2 pt of a line's y join it
const COL_GAP = 100;      // a new column opens > 100 pt right of the previous start
const COL_SLOP = 4;       // an item belongs to a column starting ≤ 4 pt right of it

export function columnStarts(page: PdfPage): number[] {
  const xs = [...new Set(page.items.filter((i) => CODE_ONLY_RE.test(i.str.trim())).map((i) => i.x))].sort(
    (a, b) => a - b,
  );
  const starts: number[] = [];
  for (const x of xs) if (!starts.length || x - starts[starts.length - 1] > COL_GAP) starts.push(x);
  return starts.length ? starts : [0, page.width / 2];
}

/** Split one baseline at horizontal gaps > SEG_GAP (needs item widths; without `w` the
 *  baseline stays whole). A bare code segment is re-joined to the text after it — the
 *  code→title gap is 20–33 pt on master pages. Measured case: a division title wrap
 *  ("Purification, and", x 163) shares a baseline with the explanation column (x 376). */
const SEG_GAP = 20;
function splitAtGaps(its: PdfItem[]): PdfItem[][] {
  const segs: PdfItem[][] = [];
  let end = -Infinity;
  for (const it of its) {
    const gap = it.w === undefined ? 0 : it.x - end;
    if (segs.length && gap > SEG_GAP && it.str.trim()) {
      const prevText = segs[segs.length - 1].map((i) => i.str).join("").trim();
      if (LOOSE_CODE_ONLY_RE.test(prevText)) segs[segs.length - 1].push(it);
      else segs.push([it]);
    } else if (segs.length) segs[segs.length - 1].push(it);
    else segs.push([it]);
    if (it.w !== undefined) end = Math.max(end, it.x + it.w);
  }
  return segs;
}

export interface BuildOptions {
  /** Split baselines at wide gaps (master-list pages). Off for the index, whose
   *  abbreviation rows put the expansion > 20 pt right of the abbreviation. */
  splitGaps?: boolean;
}

export function buildLines(page: PdfPage, opts: BuildOptions = {}): Line[] {
  const starts = columnStarts(page);
  const colOf = (x: number) => {
    let c = 0;
    for (let k = 0; k < starts.length; k++) if (x >= starts[k] - COL_SLOP) c = k;
    return c;
  };
  const byCol: PdfItem[][] = starts.map(() => []);
  for (const it of page.items) if (it.str.length) byCol[colOf(it.x)].push(it);
  const out: Line[] = [];
  byCol.forEach((items, col) => {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const clusters: { y: number; items: PdfItem[] }[] = [];
    for (const it of sorted) {
      const c = clusters[clusters.length - 1];
      if (c && Math.abs(c.y - it.y) <= Y_TOL) c.items.push(it);
      else clusters.push({ y: it.y, items: [it] });
    }
    for (const c of clusters) {
      const sortedItems = c.items.sort((a, b) => a.x - b.x);
      for (const its of opts.splitGaps ? splitAtGaps(sortedItems) : [sortedItems]) {
        // pdfjs emits explicit " " items between words (measured: 0 adjacent pairs on
        // one baseline needing a synthetic space), so items are concatenated as-is.
        const text = its.map((i) => i.str).join("").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const visible = its.filter((i) => i.str.trim());
        const x = visible[0].x;
        const lm = LOOSE_CODE_LINE_RE.exec(text);
        const m = lm ? [lm[0], `${lm[1]} ${lm[2]} ${lm[3]}${lm[4]}`, lm[5]] : null;
        let textX = x;
        if (m) {
          const codeItem = visible.findIndex((i) => CODE_ITEM_RE.test(i.str.trim()));
          const after = codeItem >= 0 ? visible[codeItem + 1] : undefined;
          if (after) textX = after.x;
        }
        const line: Line = {
          page: page.page, col, colStart: starts[col], x, y: c.y, h: Math.max(...its.map((i) => i.h)),
          text: m ? `${m[1]} ${m[2]}` : text, code: m ? m[1] : null, body: m ? m[2] : text, textX,
        };
        if (its.every((i) => i.w !== undefined)) {
          line.right = Math.max(...its.map((i) => i.x + (i.w ?? 0)));
          const first = visible.find((i) => i.x >= textX - 0.5 && !CODE_ITEM_RE.test(i.str.trim()));
          if (first) {
            const s0 = first.str.trim();
            const fw = s0.split(/\s+/)[0];
            line.firstWordW = ((first.w ?? 0) * fw.length) / Math.max(1, s0.length);
          }
        }
        out.push(line);
      }
    }
  });
  return out;
}

// ───────────────────────────── titles ─────────────────────────────

export function levelOf(code: string): 2 | 3 | 4 | 5 {
  if (code.includes(".")) return 5;
  const [, b, d] = code.split(" ");
  if (b === "00" && d === "00") return 2;
  if (d === "00") return 3;
  return 4;
}

/** Remove adjacent duplicate words (case-insensitive). Returns the count removed. */
export function dedupeAdjacentWords(s: string): { text: string; removed: number } {
  const words = s.split(" ").filter(Boolean);
  const kept: string[] = [];
  let removed = 0;
  for (const w of words) {
    if (kept.length && kept[kept.length - 1].toLowerCase() === w.toLowerCase()) removed++;
    else kept.push(w);
  }
  return { text: kept.join(" "), removed };
}

export interface StripResult { title: string; overGrab: boolean; dupWords: number; rejected: boolean }

/** PLAN §5.2 parse half: cut at the first strip match, dedupe adjacent words, reject for/see. */
export function stripTitle(raw: string): StripResult {
  let t = raw.replace(/\s+/g, " ").trim();
  const m = TITLE_STRIP_RE.exec(t);
  const overGrab = !!m;
  if (m) t = t.slice(0, m.index).replace(/[\s–-]+$/, "").trim();
  const d = dedupeAdjacentWords(t);
  // Titles never end in a period; one master row (43 05 05) prints a trailing '.'.
  t = d.text.replace(/\.$/, "").trim();
  const rejected = REJECT_TITLE_RE.test(t);
  return { title: rejected ? "" : t, overGrab, dupWords: d.removed, rejected };
}

// ───────────────────────────── master list ─────────────────────────────

interface RawEntry {
  code: string; title: string; includes: string[]; alt: string[]; see: { code: string; text: string }[];
  notes: string[]; other: string[];
}
type BlockKey = "includes" | "alt" | "see" | "notes" | "other";
const BLOCK_KEY: Record<string, BlockKey> = {
  Includes: "includes", "Alternate Terms/Abbreviations": "alt", See: "see", "See Also": "see", Notes: "notes",
};

/** A title wraps onto a line that starts at the title's own x (measured: side notes sit at
 *  x≈375–387, explanation blocks at 230/247, page furniture elsewhere). */
const TITLE_X_TOL = 3;
const TITLE_MIN_INDENT = 20;
/** Division title pages print code+title as ONE item at ~20 pt, so the title x is unknown;
 *  their wraps are recognised by the same large font instead (body text is 11 pt). */
const DIV_TITLE_H = 15;
const TITLE_WRAP_START_RE = /^(and|or|of|for|with|to|in|the|on|by)\s/;
/** `aligned`: the line starts at the title's own x, where only title text is printed, so a
 *  lower-case start is accepted there ("Switchgear and protection" / "devices"). */
const isTitleContinuation = (s: string, aligned: boolean) =>
  (aligned || /^[A-Z]/.test(s) || TITLE_WRAP_START_RE.test(s)) && s.length < 70 && s !== s.toUpperCase() &&
  !TITLE_HEADER_RE.test(s) && !BLOCK_RE.test(s);

/** Split "a: b. c: d." alternate-term text into unique terms (prototype rule). */
export function splitAltTerms(alt: string[]): string[] {
  const terms = new Set<string>();
  for (const a of alt) {
    for (const seg of a.split(/[.;]\s+|\.$/)) {
      for (const p of seg.split(":")) {
        const t = p.trim().replace(/\.$/, "");
        if (t.length > 1 && t.length < 80) terms.add(t);
      }
    }
  }
  return [...terms].sort();
}

export interface MasterParse {
  master: MasterEntry[];
  overGrabTitles: number;
  dupWords: number;
  rejectedTitles: { code: string; title: string }[];
}

export function parseMasterList(lines: Line[]): MasterParse {
  const entries = new Map<string, RawEntry>();
  let cur: RawEntry | null = null;
  let curTitleX = 0;
  let curCodeX = 0;
  let curIsRange = false;
  let curH = 0;
  let block: string | null = null;
  const push = (key: BlockKey, s: string, append: boolean) => {
    if (!cur || !s) return;
    if (key === "see") {
      const mm = SEE_CONT_RE.exec(s);
      if (mm) cur.see.push({ code: mm[1], text: mm[2] });
      else if (append && cur.see.length) cur.see[cur.see.length - 1].text += " " + s;
      else cur.see.push({ code: "?", text: s });
      return;
    }
    const list = cur[key];
    if (append && list.length) list[list.length - 1] += " " + s;
    else list.push(s);
  };
  /** At the title's own x; for a range row anywhere right of the code up to the title
   *  start, because its title starts late (x 180) and wraps back to the title column (x 162).
   *  (Widening this for every row picks up the Level-2 listing's "Division NN" lines.) */
  const inTitleBand = (ln: Line) =>
    curIsRange
      ? ln.x > curCodeX + TITLE_MIN_INDENT && ln.x <= curTitleX + TITLE_X_TOL
      : Math.abs(ln.x - curTitleX) <= TITLE_X_TOL;
  for (const ln of lines) {
    const line = ln.text.replace(HEADER_TAIL_RE, "");
    if (MASTER_NOISE_RE.test(line) || HEADER_FRAGMENT_RE.test(line)) continue;
    if (ln.code && !BLOCK_RE.test(line)) {
      const code = ln.code;
      // Range rows ("04 80 00 to 04 90 00 Unassigned", "45 11 10 to 45 12 99 User-Defined …")
      // are entries of their first code, titled by the text after the range.
      const range = RANGE_RE.exec(ln.body);
      const title = range ? range[1] : ln.body;
      // MasterFormat titles start upper-case. A code row with a lower-case body is a
      // reference inside an explanation block ("08 12 00 for metal frames only.",
      // "33 05 00 and 33 31 00 for piping …", "09 73 00 or wall carpeting.").
      if (/^[a-z]/.test(title)) {
        if (cur && block && BLOCK_KEY[block] !== "see") push(BLOCK_KEY[block] ?? "other", `${code} ${title}`, true);
        else if (cur) cur.see.push({ code, text: title });
        continue;
      }
      const prev = entries.get(code);
      if (prev) {
        // Re-definition (the Level-2 listing precedes the full list): the full list wins.
        prev.title = title;
        cur = prev;
      } else {
        cur = { code, title, includes: [], alt: [], see: [], notes: [], other: [] };
        entries.set(code, cur);
      }
      curTitleX = ln.textX;
      curCodeX = ln.x;
      curIsRange = !!range;
      curH = ln.h;
      block = null;
      continue;
    }
    if (!cur) continue;
    const b = BLOCK_RE.exec(line);
    if (
      // Geometry, not block state, decides: on division pages the explanation column is
      // interleaved by y with the title's wraps ("Includes:" sits above "Purification, and").
      !b &&
      (inTitleBand(ln) || (curH >= DIV_TITLE_H && Math.abs(ln.h - curH) <= 1)) &&
      isTitleContinuation(line, inTitleBand(ln))
    ) {
      cur.title += " " + line;
      continue;
    }
    if (b) {
      block = b[1];
      push(BLOCK_KEY[block] ?? "other", b[2].trim(), false);
      continue;
    }
    if (block) push(BLOCK_KEY[block] ?? "other", line.trim(), true);
  }

  const master: MasterEntry[] = [];
  let overGrabTitles = 0;
  let dupWords = 0;
  const rejectedTitles: { code: string; title: string }[] = [];
  for (const e of entries.values()) {
    const s = stripTitle(e.title);
    if (s.overGrab) overGrabTitles++;
    if (s.dupWords) dupWords++;
    if (s.rejected) rejectedTitles.push({ code: e.code, title: e.title });
    const norm = (xs: string[]) => xs.map((x) => x.replace(/\s+/g, " ").trim());
    master.push({
      code: e.code, title: s.title, level: levelOf(e.code), includes: norm(e.includes),
      altTerms: splitAltTerms(norm(e.alt)), see: e.see.map((x) => ({ code: x.code, text: x.text.trim() })),
      notes: norm(e.notes),
    });
  }
  return { master, overGrabTitles, dupWords, rejectedTitles };
}

// ───────────────────────────── keyword index ─────────────────────────────

const DEEPER = 3;     // PLAN §5.1: deeper = textX > line.textX + 3 pt
const SAME_X = 2.5;   // a wrapped line repeats the text x of the line it continues (±2.1 pt measured)
/** Offset from the column start that separates head-level (36) from sub-level (47) text. */
const SUB_LEVEL_OFFSET = 41.5;

type Kind = "coded" | "abbrev" | "synonym" | "plain" | "skip";
type Role = "cont" | "head" | "headCont" | "orphan";

function kindOf(l: Line): Kind {
  if (INDEX_NOISE_RE.test(l.text) || XX_RE.test(l.text)) return "skip";
  if (l.code) return "coded";
  if (LEADER_RE.test(l.text) || SEE_SPLIT_RE.test(l.text) || /\s[-–]\s*see$/i.test(l.text)) return "synonym";
  if (Math.abs(l.x - l.colStart) <= 3 && ABBREV_RE.test(l.text)) return "abbrev";
  return "plain";
}

/** Only punctuation marks a wrap at a line end: heads and inverted entries legitimately end
 *  in a connector ("bids, scopes of", "operation and maintenance of"). */
const WRAP_END_RE = /[,\-–(]$/;
const WRAP_START_RE = /^(and|or|of|for|with|to|in|the|on|by)\s/i; // "in-line" is not a wrap
/** Does `next` read as the wrapped tail of `prev` (rather than a new head)? */
const looksLikeWrap = (prev: Line, next: Line) => WRAP_END_RE.test(prev.text) || WRAP_START_RE.test(next.text);

const DANGLING_SEE_RE = /\s[-–]\s*see$/i;
/** Index sort key, word-by-word as the index is printed: a comma ends the term (sorts
 *  before a space: "cleaning, lubrication" < "cleaning concrete") and a hyphen joins a word
 *  (sorts after a space: "acrylic plastic" < "acrylic-impregnated"). */
const sortKey = (s: string) =>
  s.toLowerCase().replace(/,/g, "\u0001").replace(/[^a-z0-9 \-\u0001]+/g, "").replace(/\s+/g, " ").trim();
const firstWord = (s: string) => sortKey(s).split(/[ \u0001-]/)[0] ?? "";
const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** Index text box: no glyph ends further than 137 pt right of the column start (measured
 *  over pp. 628–713: p99 136, max 137, one outlier). */
const INDEX_TEXT_RIGHT = 138;
const SPACE_W = 2;
/** The first-word width is estimated from character share, so "would have fit" is claimed
 *  only with room to spare (measured miss: "slurry-geomembrane" + "composite" estimated at
 *  135.5 yet wrapped). */
const FIT_MARGIN = 6;
/** true / false when widths are known: could `next`'s first word have been set on `prev`'s
 *  line? If it could, the line break was not forced by width, so `next` is NOT a wrap. */
function fitsOnPrev(prev: Line, next: Line): boolean | null {
  if (prev.right === undefined || next.firstWordW === undefined) return null;
  return prev.right + SPACE_W + next.firstWordW <= INDEX_TEXT_RIGHT - FIT_MARGIN;
}

function joinWrap(a: string, b: string): string {
  return /-$/.test(a) ? a + b : `${a} ${b}`;
}

export interface IndexParse {
  index: IndexEntry[];
  abbrevRows: AbbrevRow[];
  synonyms: Synonym[];
  heads: number;
  headsCoded: number;
  headless: number;
  orphans: number;
  skippedXX: number;
}

/** Group lines into reading-order columns: page, then column, top-down (buildLines order). */
function columnsOf(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  let key = "";
  for (const l of lines) {
    const k = `${l.page}:${l.col}`;
    if (k !== key) { out.push([]); key = k; }
    out[out.length - 1].push(l);
  }
  return out;
}

export interface IndexOptions {
  /** Keep the open head across column/page breaks (the printed flow continues there).
   *  Default TRUE (S1 decision, 2026-10-19): measured on the full PDF, PLAN §5.1's
   *  "reset at every break" drops 1,312 of 12,511 index rows (10.5%) as head-less, and the
   *  printed flow demonstrably continues across columns (p.653 col 1 holds sub-entries of
   *  "11 00 00 equipment" from col 0). `false` = PLAN §5.1 as written, kept for comparison. */
  carryHeads?: boolean;
}

export function parseIndex(lines: Line[], opts: IndexOptions = {}): IndexParse {
  const carryHeads = opts.carryHeads ?? true;
  const res: IndexParse = { index: [], abbrevRows: [], synonyms: [], heads: 0, headsCoded: 0, headless: 0, orphans: 0, skippedXX: 0 };
  // All x from here on is relative to the line's own column start, so levels compare
  // across columns (odd/even pages start at 72 vs 55).
  const rel = lines.map((l) => ({
    ...l, x: l.x - l.colStart, textX: l.textX - l.colStart, colStart: 0,
    right: l.right === undefined ? undefined : l.right - l.colStart,
  }));
  for (const colLines of carryHeads ? [rel] : columnsOf(rel)) {
    const L = colLines.filter((l) => {
      if (XX_RE.test(l.text)) { res.skippedXX++; return false; }
      return kindOf(l) !== "skip";
    });
    const kind = L.map(kindOf);
    const deeperAfter = (k: number, x: number) => k < L.length && L[k].textX > x + DEEPER;
    const runEnd = (j: number) => {
      let k = j;
      while (k + 1 < L.length && kind[k + 1] === "plain" && Math.abs(L[k + 1].textX - L[j].textX) <= SAME_X) k++;
      return k;
    };
    // Pass 1: classify every un-coded line as continuation / head / orphan.
    const role: (Role | null)[] = L.map(() => null);
    /** Body of the next line at x's level after the run ending at `k` and its deeper lines. */
    const nextAtLevel = (k: number, x: number): string | null => {
      for (let q = k + 1; q < L.length; q++) {
        if (L[q].textX > x + DEEPER) continue;
        return Math.abs(L[q].textX - x) <= SAME_X && (kind[q] === "coded" || kind[q] === "plain") ? L[q].body : null;
      }
      return null;
    };
    for (let j = 0; j < L.length; j++) {
      if (kind[j] !== "plain" || role[j]) continue;
      const prev = j > 0 ? L[j - 1] : null;
      const pk = j > 0 ? kind[j - 1] : null;
      const k = runEnd(j);
      const headFollows = deeperAfter(k + 1, L[j].textX);
      const markHead = () => { role[j] = "head"; for (let q = j + 1; q <= k; q++) role[q] = "headCont"; };
      const sameX = prev !== null && pk !== "synonym" && pk !== "abbrev" && Math.abs(prev.textX - L[j].textX) <= SAME_X;
      const tailOfRef = prev !== null && (pk === "synonym" || pk === "abbrev") && L[j].textX >= prev.x - SAME_X;
      if (prev && pk === "synonym" && DANGLING_SEE_RE.test(prev.text)) {
        role[j] = "cont"; // "X - see" ends the line: this line is Y
      } else if (sameX || tailOfRef) {
        // The run j..k may be [wrapped tail of the entry above] + [a new head]. Heads are
        // alphabetical, so the head starts at a line s whose text H sorts ≤ the next head-level
        // line N (and, inside a multi-line run, whose first word is ≥ the entry above's):
        //   "33 82 53 cleaning, lubrication" / "chemicals, communications" / "cleaning concrete"
        //     → the middle line is a tail, "cleaning concrete" is the head;
        //   "00 73 36 equal employment" / "opportunity" / subs / N "equipment" → no head:
        //     the line is a tail and the coded line is the head.
        let q = j - 1;
        while (q > 0 && role[q] === "cont") q--;
        // An abbreviation row is filed by its expansion ("EMI electromagnetic-interference").
        const aboveText = kind[q] === "abbrev" ? (ABBREV_RE.exec(L[q].text)?.[2] ?? L[q].body) : L[q].body;
        const above = firstWord(aboveText);
        const n = headFollows ? nextAtLevel(k, L[j].textX) : null;
        // The index is not strictly sorted ("backing tile, clay" precedes "backboxes"), so the
        // first-word bound only CHOOSES the start inside a multi-line run; it never vetoes.
        let start = -1;
        if (headFollows) {
          // Geometry bounds the start: if a line's first word WOULD have fit on the line above,
          // that break was the typesetter's choice, not width's — the line is not a wrap, so the
          // head starts there at the latest. (Not fitting proves nothing: entries are short.)
          let latest = k + 1;
          for (let c = j; c <= k && latest > k; c++) if (fitsOnPrev(L[c - 1], L[c]) === true) latest = c;
          const valid: number[] = [];
          for (let c = j; c <= Math.min(k, latest); c++) {
            const h = L.slice(c, k + 1).map((x) => x.text).reduce(joinWrap);
            // Alphabetical neighbour: a line whose first word shares ≥ 3 leading letters with the
            // entry above starts a new group even where the index is out of order (measured:
            // light troffer diffusers / lightweight concrete, steel splined … / steel studs).
            const neighbour = commonPrefix(firstWord(h), above) >= 3;
            // Otherwise a new head sorts between the entry above and the next head-level line N
            // ("reservoir sump floating" / "covers" is a wrap: covers < reservoir).
            const between = firstWord(h) >= above && (n === null || sortKey(h) <= sortKey(n));
            if (!looksLikeWrap(L[c - 1], L[c]) && (neighbour || between)) valid.push(c);
          }
          start = valid.length ? valid[0] : latest <= k ? latest : -1;
        }
        for (let c = j; c <= k; c++) role[c] = start === -1 || c < start ? "cont" : c === start ? "head" : "headCont";
      } else if (headFollows) {
        markHead();
      } else {
        role[j] = "orphan";
        for (let q = j + 1; q <= k; q++) role[q] = "cont";
      }
    }
    // Pass 2: walk the column. `last` receives continuations.
    type Head = { text: string; textX: number };
    let curHead: Head | null = null;
    let last: { append: (s: string) => void } | null = null;
    let openSyn = null as { raw: string; x: number } | null;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      const kd = kind[i];
      if (kd !== "synonym") openSyn = null;
      if (kd === "coded") {
        const code = l.code as string;
        if (curHead && l.textX > curHead.textX + DEEPER) {
          const head = curHead;
          const e: IndexEntry = { code, text: l.body, head: head.text, phrase: "", page: l.page };
          res.index.push(e);
          last = { append: (s) => { e.text = joinWrap(e.text, s); } };
          continue;
        }
        if (l.textX - l.colStart > SUB_LEVEL_OFFSET) {
          res.headless++;
          last = { append: () => {} };
          continue;
        }
        const e: IndexEntry = { code, text: l.body, head: null, phrase: "", page: l.page };
        res.index.push(e);
        let k = i + 1;
        while (k < L.length && role[k] === "cont" && Math.abs(L[k].textX - l.textX) <= SAME_X) k++;
        if (deeperAfter(k, l.textX)) {
          const h: Head = { text: e.text, textX: l.textX };
          curHead = h;
          res.heads++;
          res.headsCoded++;
          last = { append: (s) => { e.text = joinWrap(e.text, s); h.text = e.text; } };
        } else {
          curHead = null;
          last = { append: (s) => { e.text = joinWrap(e.text, s); } };
        }
        continue;
      }
      if (kd === "abbrev") {
        const m = ABBREV_RE.exec(l.text) as RegExpExecArray;
        const r: AbbrevRow = { abbr: m[1], expansion: m[2] };
        res.abbrevRows.push(r);
        // Abbreviation rows sit at the code x but are filed by expansion, so their level
        // is read from what follows: sub-level lines after the row mean the row is either
        // inside the open head's list ("GFRC concrete" under glass-fiber-reinforced) or,
        // with no head open, is itself the head ("HV high-voltage" → circuit breakers).
        let q = i + 1;
        while (q < L.length && role[q] === "cont") q++;
        const subNext = q < L.length && L[q].textX - L[q].colStart > SUB_LEVEL_OFFSET;
        if (subNext && curHead) {
          const head = curHead;
          r.expansion = `${r.expansion}, ${head.text}`;
          last = { append: (s) => { r.expansion = joinWrap(r.expansion.slice(0, -(head.text.length + 2)), s) + `, ${head.text}`; } };
        } else if (subNext) {
          const h: Head = { text: r.expansion, textX: l.colStart + 36 };
          curHead = h;
          res.heads++;
          last = { append: (s) => { r.expansion = joinWrap(r.expansion, s); h.text = r.expansion; } };
        } else {
          curHead = null;
          last = { append: (s) => { r.expansion = joinWrap(r.expansion, s); } };
        }
        continue;
      }
      if (kd === "synonym") {
        let raw = l.text.replace(LEADER_RE, "").trim();
        // "……….. preservation project" / "procedures – see historic" / "treatment procedures":
        // a see-less synonym line continues on the next, indented, line.
        const prior = openSyn;
        let anchorX = l.x;
        if (prior !== null && !LEADER_RE.test(l.text) && l.x > prior.x + DEEPER) {
          raw = joinWrap(prior.raw, raw);
          anchorX = prior.x;
          res.synonyms.pop();
        }
        const parts = raw.split(SEE_SPLIT_RE);
        const syn: Synonym = { from: parts[0].trim(), to: (parts[1] ?? "").trim() };
        res.synonyms.push(syn);
        openSyn = parts.length > 1 || DANGLING_SEE_RE.test(raw) ? null : { raw, x: anchorX };
        curHead = null;
        last = {
          append: (s) => {
            if (!syn.to && !DANGLING_SEE_RE.test(raw) && SEE_SPLIT_RE.test(` ${s}`)) {
              const p2 = joinWrap(raw, s).split(SEE_SPLIT_RE);
              syn.from = p2[0].trim();
              syn.to = (p2[1] ?? "").trim();
              return;
            }
            syn.to = syn.to ? joinWrap(syn.to, s) : s;
          },
        };
        continue;
      }
      // plain
      const r = role[i];
      if (r === "cont" && last) { last.append(l.text); continue; }
      if (r === "head") {
        const h: Head = { text: l.text, textX: l.textX };
        curHead = h;
        res.heads++;
        last = { append: (s) => { h.text = joinWrap(h.text, s); } };
        continue;
      }
      if (r === "headCont" && last) { last.append(l.text); continue; }
      res.orphans++;
      curHead = null;
      last = { append: () => {} };
    }
  }
  for (const e of res.index) e.phrase = e.head ? `${e.text}, ${e.head}` : e.text;
  for (const s of res.synonyms) {
    s.from = s.from.replace(/\s*[-–]\s*$/, "").trim();
    s.to = s.to.replace(/^see\s+/i, "").trim();
  }
  return res;
}

// ───────────────────────────── whole document ─────────────────────────────

/** Titles with a likely mid-word break (pypdf printed "Scree n"): an adjacent pair whose
 *  join is a title word seen ≥ 2 times while one half is seen ≤ 1 time. */
export function countSplitWordArtifacts(titles: string[]): number {
  const freq = new Map<string, number>();
  // Whitespace tokens with edge punctuation trimmed: "Bidder's" and "Hand-Held" stay whole
  // (splitting on [^a-z] made 3 false positives out of them).
  const toks = titles.map((t) =>
    t.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")).filter(Boolean),
  );
  for (const ts of toks) for (const t of ts) freq.set(t, (freq.get(t) ?? 0) + 1);
  let n = 0;
  for (const ts of toks) {
    for (let i = 0; i + 1 < ts.length; i++) {
      const joined = ts[i] + ts[i + 1];
      if ((freq.get(joined) ?? 0) >= 2 && ((freq.get(ts[i]) ?? 0) <= 1 || (freq.get(ts[i + 1]) ?? 0) <= 1)) { n++; break; }
    }
  }
  return n;
}

/** A master-list page carries the "Master List …" footer; the Level-2 listing that opens
 *  the section (pp. 26–40) carries "Level 2 Number(s) and Titles" instead. Both lie inside
 *  the measured 18–625 span, so the second mark only matters for page excerpts. */
export function isMasterPage(page: PdfPage): boolean {
  return page.items.some((i) => i.str.includes(MASTER_PAGE_MARK) || LEVEL2_MARK_RE.test(i.str));
}
export function isIndexPage(page: PdfPage): boolean {
  return page.items.some((i) => INDEX_PAGE_RE.test(i.str));
}

export function parseDocument(pages: PdfPage[], opts: IndexOptions = {}): MfParsed & { extra: { heads: number; headsCoded: number; orphans: number; skippedXX: number; masterPages: [number, number]; indexPages: [number, number] } } {
  const ml = pages.filter(isMasterPage).map((p) => p.page);
  const ki = pages.filter(isIndexPage).map((p) => p.page);
  const lo = Math.min(...ml), hi = Math.max(...ml), klo = Math.min(...ki), khi = Math.max(...ki);
  const linesIn = (a: number, b: number, bo: BuildOptions) =>
    pages.filter((p) => p.page >= a && p.page <= b).flatMap((p) => buildLines(p, bo));
  const mp = parseMasterList(linesIn(lo, hi, { splitGaps: true }));
  const ip = parseIndex(linesIn(klo, khi, {}), opts);
  const codes = new Set(mp.master.map((e) => e.code));
  return {
    pages: pages.length,
    master: mp.master,
    index: ip.index,
    abbrevRows: ip.abbrevRows,
    synonyms: ip.synonyms,
    report: {
      overGrabTitles: mp.overGrabTitles,
      dupWords: mp.dupWords,
      rejectedTitles: mp.rejectedTitles,
      headless: ip.headless,
      danglingIndexCodes: ip.index.filter((e) => !codes.has(e.code)).length,
      danglingSee: mp.master.reduce((n, e) => n + e.see.filter((s) => s.code !== "?" && !codes.has(s.code)).length, 0),
      splitWordArtifacts: countSplitWordArtifacts(mp.master.map((e) => e.title)),
      unassigned: mp.master.filter((e) => /^unassigned$/i.test(e.title)).length,
    },
    extra: { heads: ip.heads, headsCoded: ip.headsCoded, orphans: ip.orphans, skippedXX: ip.skippedXX, masterPages: [lo, hi], indexPages: [klo, khi] },
  };
}

// ───────────────────────────── pdfjs ─────────────────────────────

interface PdfjsTextItem { str?: string; transform?: number[]; height?: number; width?: number }
interface PdfjsPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfjsTextItem[] }>;
  cleanup(): void;
}
interface PdfjsDoc { numPages: number; getPage(n: number): Promise<PdfjsPage>; destroy(): Promise<void> }
interface Pdfjs {
  getDocument(o: { data: Uint8Array; useSystemFonts: boolean; verbosity: number }): { promise: Promise<PdfjsDoc> };
}

export function pdfjsPath(): string {
  const candidates = [
    process.env.BP_PDFJS,
    PDFJS_ABS,
    join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.mjs"),
  ].filter((p): p is string => !!p);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`[mf-parse] pdfjs not found; tried ${candidates.join(", ")}`);
  return hit;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Extract pdfjs text items. `only` restricts to those 1-based page numbers. */
export async function extractPages(pdfPath: string, only?: number[]): Promise<PdfPage[]> {
  const pdfjs = (await import(/* @vite-ignore */ pdfjsPath())) as Pdfjs;
  // Bytes, not a url: under a DOM-like test environment pdfjs would `fetch` a url.
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const want = only ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const pages: PdfPage[] = [];
  for (const n of want) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const it of tc.items) {
      if (typeof it.str !== "string" || !it.str.length || !it.transform) continue;
      items.push({ str: it.str, x: r2(it.transform[4]), y: r2(it.transform[5]), h: r2(it.height ?? 0), w: r2(it.width ?? 0) });
    }
    pages.push({ page: n, width: vp.width, height: vp.height, items });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  // Default carries heads across column/page breaks (see IndexOptions); --reset-heads = PLAN §5.1 literal.
  const carryHeads = !process.argv.includes("--reset-heads");
  const pdf = args[0] ?? DEFAULT_PDF;
  const out = args[1] ?? DEFAULT_OUT;
  if (!existsSync(pdf)) throw new Error(`[mf-parse] PDF not found: ${pdf}`);
  const pages = await extractPages(pdf);
  const parsed = parseDocument(pages, { carryHeads });
  const { extra, ...json } = parsed;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(json) + "\n");
  const byLevel = [2, 3, 4, 5].map((lv) => json.master.filter((e) => e.level === lv).length);
  const { rejectedTitles, ...counters } = json.report;
  console.error(
    `[mf-parse] pages=${json.pages} master ${extra.masterPages.join("-")} codes=${json.master.length} ` +
      `L2/L3/L4/L5=${byLevel.join("/")} | index ${extra.indexPages.join("-")} entries=${json.index.length} ` +
      `heads=${extra.heads} subs=${json.index.filter((e) => e.head).length} abbrevRows=${json.abbrevRows.length} ` +
      `synonyms=${json.synonyms.length} orphans=${extra.orphans} xxSkipped=${extra.skippedXX}\n` +
      `[mf-parse] carryHeads=${carryHeads} headsCoded=${extra.headsCoded} headsUncoded=${extra.heads - extra.headsCoded}\n` +
      `[mf-parse] report ${JSON.stringify({ ...counters, rejectedTitles: rejectedTitles.length })} → ${out}`,
  );
}

// Entry guard — importing this from a test must not run the CLI (see score.ts).
if (process.argv[1]?.includes("csi-mf-parse")) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
