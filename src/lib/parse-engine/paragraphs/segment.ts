/**
 * Paragraph segmenter (K31–K35, K09; pure, deterministic: E-7).
 *
 * Reads the text lines inside a box into `StructureParagraphDoc`: blocks (a header and what follows it),
 * paragraphs (a key and its wrapped lines), spec hierarchy (`1.01 › A › 1`) and key–value legend rows.
 * It is exported for the automatic stages too (A03 binders and A12 note blocks route here under
 * `notesAuto`, PLAN §3.5 / WP-3.J) and for the read-time reference fallback (WP-4.F).
 *
 * Rules, each the fix of one K-finding:
 * - A paragraph is a key line plus every following unkeyed line until the next key or header (K31: a
 *   wrapped note is one paragraph, not a `paragraph` region the Notes tools cannot see).
 * - A key is the whole first token (`paragraphs/keys.ts`): `2.5 MM` and `1:50` are text (K35). A strong
 *   key (`4.`, `(4)`, `A.`, `1.01`, `K-01`) is accepted when it stands in the block's key column for its
 *   class or continues the sequence; a weak key (bare `4`, `2.3`) needs both.
 * - A header is a whole upper-case line (K34). It opens a block and resets numbering (K35: "ELECTRICAL
 *   NOTES › 1" is not note 6 of GENERAL NOTES). `(CONT.)` marks the block `continued` (§1.7 rule 5).
 * - Lines before the first key are kept as unkeyed paragraphs (K35: lead-ins were dropped).
 * - Columns: Textract LAYOUT `list`/`text` blocks inside the box when present, else vertical gutters with
 *   content on both sides. Header lines and lines wider than 60 % of the content do not count against a
 *   gutter, and one more crossing line is tolerated (two for a long list: 10 % of the peak, the legacy
 *   splitter's rule) — a title spanning two columns no longer turns detection off (VERIFY HIGH-1). An
 *   empty run at the box edge is slack, not a gutter (K33). A line that crosses a cut spans the columns:
 *   the text reads in bands (each column of the band, left to right, then the spanning line).
 * - A bare key token printed as its own LINE with its text as another LINE on the same row is one row
 *   (merged before columns), so a keynote list is never split into a key column and a text column
 *   (VERIFY HIGH-2; K09's failure mode through keys).
 * - A first-of-class key under an open key column of another class is a child level only when it is
 *   indented right of its parent's column AND starts its sequence; an unaligned in-sequence key at the
 *   open paragraph's text indent is a wrapped line ("R-19 WALLS", "(2) LAYERS"; VERIFY MED-1).
 * - A header-shaped line at the hanging indent of the open paragraph, with no paragraph gap above, is a
 *   wrapped line ("… WITH MANUFACTURER'S SPECIFICATIONS"; VERIFY MED-2).
 * - A block with no keys whose rows pair as key/value (`kv-pairs.ts`, K09) becomes one paragraph per pair.
 *
 * Boxes are normalised MinMax (E-4). Imports only parse-engine modules (`../lines` is not needed: a
 * line's text is the loader's). Capability `paragraphs` (ledger `eval/parse-engine/capabilities/paragraphs.json`).
 */

import { centreIn, unionBox } from "../geometry";
import { PARSE_ENGINE_CAPS, type BboxMinMax, type EngineLayoutBlock, type EnginePageEvidence, type MethodId, type Paragraph, type ParagraphBlock, type StructureParagraphDoc } from "../types";
import type { SegmentLine, SegmentOptions, SegmentRequest, SegmentResult } from "../types-paragraphs";
import { kvPairs } from "./kv-pairs";
import { matchHeader, matchKey, normaliseKey, type HeaderMatch, type KeyClass, type KeyMatch } from "./keys";

const DEFAULTS: Required<SegmentOptions> = {
  minGutterHeights: 1.5,
  keyColumnTolHeights: 1.0,
  paragraphGapHeights: 2.0,
  kvMinGapRatio: 0.05,
  kvMaxKeyLen: 20,
  kvMinPairs: 3,
};
const GUTTER_BINS = 200;
const MIN_LINES_PER_COLUMN = 2;
/** A line wider than this share of the content's x extent spans columns and does not block a gutter. */
const SPANNING_WIDTH_SHARE = 0.6;
/** A bare key LINE pairs with a text LINE on its row at most this × the median line height to its right. */
const KEY_ROW_MAX_GAP_HEIGHTS = 10;

type Box = readonly [number, number, number, number];

function finiteBox(b: unknown): b is Box {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));
}
function clampBox(b: Box): BboxMinMax {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(b[0]), c(b[1]), c(Math.max(b[0], b[2])), c(Math.max(b[1], b[3]))];
}
function median(values: readonly number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/** The page's lines (`EnginePageEvidence.lines` + `words`) as segmenter lines, with their words attached. */
export function linesFromEvidence(ev: Pick<EnginePageEvidence, "words" | "lines">): SegmentLine[] {
  return ev.lines.map((l) => ({
    text: l.text,
    b: l.b,
    words: l.wordIdx.map((i) => ev.words[i]).filter((w) => w !== undefined).map((w) => ({ t: w.t, b: w.b })),
  }));
}

interface Item {
  i: number;
  /** Input line indices this item stands for (two when a bare key LINE was merged with its text LINE). */
  parts: number[];
  l: SegmentLine;
  x0: number;
  y0: number;
  y1: number;
  h: number;
}

// ── columns ─────────────────────────────────────────────────────────────────────────────────────

/** Column boundaries from LAYOUT list/text blocks inside the box (merged in x); null when fewer than two. */
function layoutBoundaries(layout: readonly EngineLayoutBlock[] | undefined, bbox: Box): number[] | null {
  if (!layout) return null;
  const spans = layout
    .filter((b) => (b.k === "list" || b.k === "text") && finiteBox(b.b) && centreIn(b.b, bbox))
    .map((b) => [b.b[0], b.b[2]] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  if (merged.length < 2) return null;
  const cuts: number[] = [];
  for (let k = 1; k < merged.length; k++) cuts.push((merged[k - 1][1] + merged[k][0]) / 2);
  return cuts;
}

/**
 * Column boundaries at vertical gutters with ≥ 2 lines on each side; edge runs are slack (K33).
 * `ignore` lines (headers, lines wider than 60 % of the content) do not count against a gutter, and
 * `tolerance` further crossing lines are allowed (VERIFY HIGH-1); the cut sits in the least-covered
 * stretch of the run, so a column's longest line never straddles it.
 */
function gutterBoundaries(items: readonly Item[], bbox: Box, minGutter: number, ignore: (it: Item) => boolean): number[] | null {
  const w = bbox[2] - bbox[0];
  const counted = items.filter((it) => !ignore(it));
  if (w <= 0 || counted.length < 2 * MIN_LINES_PER_COLUMN) return null;
  const cover = new Array<number>(GUTTER_BINS).fill(0);
  const binOf = (x: number) => Math.min(GUTTER_BINS - 1, Math.max(0, Math.floor(((x - bbox[0]) / w) * GUTTER_BINS)));
  for (const it of counted) {
    const a = binOf(it.l.b[0]);
    const z = binOf(it.l.b[2]);
    for (let k = a; k <= z; k++) cover[k]++;
  }
  const peak = Math.max(...cover);
  const tolerance = counted.length >= 4 * MIN_LINES_PER_COLUMN ? Math.max(1, Math.floor(0.1 * peak)) : 0;
  const cuts: number[] = [];
  const consider = (start: number, end: number) => {
    if (start <= 0 || end >= GUTTER_BINS - 1) return; // touches an edge: box slack (K33)
    // the longest stretch of the run's minimum cover
    let min = Infinity;
    for (let k = start; k <= end; k++) min = Math.min(min, cover[k]);
    let bestA = -1;
    let bestZ = -1;
    for (let k = start; k <= end; k++) {
      if (cover[k] !== min) continue;
      let z = k;
      while (z + 1 <= end && cover[z + 1] === min) z++;
      if (z - k > bestZ - bestA) {
        bestA = k;
        bestZ = z;
      }
      k = z;
    }
    const x0 = bbox[0] + (bestA / GUTTER_BINS) * w;
    const x1 = bbox[0] + ((bestZ + 1) / GUTTER_BINS) * w;
    if (x1 - x0 < minGutter) return;
    const mid = (x0 + x1) / 2;
    let left = 0;
    let right = 0;
    for (const it of items) {
      if (it.l.b[2] <= mid) left++;
      else if (it.l.b[0] >= mid) right++;
    }
    if (left >= MIN_LINES_PER_COLUMN && right >= MIN_LINES_PER_COLUMN) cuts.push(mid);
  };
  let run = -1;
  for (let k = 0; k < GUTTER_BINS; k++) {
    if (cover[k] <= tolerance) {
      if (run < 0) run = k;
    } else if (run >= 0) {
      consider(run, k - 1);
      run = -1;
    }
  }
  if (run >= 0) consider(run, GUTTER_BINS - 1);
  return cuts.length > 0 ? cuts : null;
}

/**
 * A bare key token printed as its own LINE ("1", "PT-1") plus the nearest LINE to its right on the same
 * row become one item ("1 PATCH WALL"), before columns are found (VERIFY HIGH-2). Deterministic: keys
 * are visited in reading order and take the nearest unclaimed partner (input index breaks ties).
 */
function mergeKeyRows(items: readonly Item[], medianH: number): Item[] {
  const isBareKey = (it: Item) => {
    const k = matchKey(it.l.text);
    return k !== null && k.rest === "";
  };
  const partnerOf = new Map<Item, Item>();
  const claimed = new Set<Item>();
  for (const it of items) {
    if (claimed.has(it) || !isBareKey(it)) continue;
    let best: Item | null = null;
    for (const r of items) {
      if (r === it || claimed.has(r) || partnerOf.has(r) || r.l.b[0] < it.l.b[2]) continue;
      const ov = Math.min(it.y1, r.y1) - Math.max(it.y0, r.y0);
      if (ov < 0.5 * Math.min(it.h, r.h)) continue;
      if (r.l.b[0] - it.l.b[2] > KEY_ROW_MAX_GAP_HEIGHTS * medianH) continue;
      if (isBareKey(r)) continue; // another key: a key column, not this key's text
      if (!best || r.l.b[0] < best.l.b[0] || (r.l.b[0] === best.l.b[0] && r.i < best.i)) best = r;
    }
    if (best) {
      partnerOf.set(it, best);
      claimed.add(best);
    }
  }
  if (partnerOf.size === 0) return [...items];
  const out: Item[] = [];
  for (const it of items) {
    if (claimed.has(it)) continue;
    const r = partnerOf.get(it);
    if (!r) {
      out.push(it);
      continue;
    }
    const b: BboxMinMax = [Math.min(it.l.b[0], r.l.b[0]), Math.min(it.l.b[1], r.l.b[1]), Math.max(it.l.b[2], r.l.b[2]), Math.max(it.l.b[3], r.l.b[3])];
    const words = it.l.words && r.l.words ? [...it.l.words, ...r.l.words] : undefined;
    const l: SegmentLine = { text: `${it.l.text.trim()} ${r.l.text.trim()}`, b, ...(words ? { words } : {}) };
    out.push({ i: it.i, parts: [it.i, r.i], l, x0: b[0], y0: b[1], y1: b[3], h: Math.max(b[3] - b[1], 1e-4) });
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.i - b.i);
}

/** Where the text of a line starts after its key token (its second word, or an estimate from the characters). */
function textStartX(it: Item, k: KeyMatch | null): number {
  if (!k) return it.x0;
  const ws = it.l.words ? [...it.l.words].sort((a, b) => a.b[0] - b.b[0]) : [];
  if (ws.length >= 2) return ws[1].b[0];
  const t = it.l.text.trim();
  if (t.length === 0 || k.rest === "") return it.l.b[2];
  return it.x0 + ((it.l.b[2] - it.x0) * (t.length - k.rest.length)) / t.length;
}

function columnBoxes(bbox: Box, cuts: readonly number[]): BboxMinMax[] {
  const xs = [bbox[0], ...cuts, bbox[2]];
  const out: BboxMinMax[] = [];
  for (let k = 1; k < xs.length; k++) out.push([xs[k - 1], bbox[1], xs[k], bbox[3]]);
  return out;
}

// ── accumulation ────────────────────────────────────────────────────────────────────────────────

interface StackEntry { cls: KeyClass; key: string; ordinal: number; group: string | null }
interface ParaAcc {
  id: string;
  key: string | null;
  keyPath: string[];
  depth: number;
  weak: boolean;
  lines: Item[];
  texts: string[];
  /** x where the key line's text starts (the hanging indent of a wrapped keyed paragraph). */
  textX: number;
}
interface BlockAcc {
  id: string;
  header: HeaderMatch | null;
  headerItem: Item | null;
  lines: Item[];
  paragraphs: ParaAcc[];
}

/** Does `k` continue the class's sequence in `stack` (+1, or +2 for a strong key), or start one? */
function inSequence(k: KeyMatch, stack: readonly StackEntry[]): boolean {
  const sib = [...stack].reverse().find((e) => e.cls === k.cls);
  if (sib) {
    if (k.cls === "tag" && sib.group !== k.group) return false;
    const d = k.ordinal - sib.ordinal;
    if (k.cls === "article") {
      // strong "1.01"→"1.02" is +1; weak "2.2"→"2.3" is +10 (tens); a new part starts at n.01 / n.1
      if (d === 1 || d === 10) return true;
      return k.strong && (d === 2 || d === 20 || k.ordinal % 100 === 1 || k.ordinal % 100 === 10);
    }
    return d === 1 || (k.strong && d === 2);
  }
  // first of its class in the block
  if (k.cls === "article") return k.ordinal % 100 === 1 || k.ordinal % 100 === 10;
  // a tag list starts a block, or a sub-list at its first tag ("PT-1"); "R-19" mid-note is no list (VERIFY MED-1)
  if (k.cls === "tag") return k.strong && (stack.length === 0 || k.ordinal <= 1);
  return k.ordinal === 1;
}

export function segmentParagraphsDetailed(req: SegmentRequest, options: SegmentOptions = {}): SegmentResult {
  const o = { ...DEFAULTS, ...options };
  const bbox: Box = finiteBox(req.bbox) ? req.bbox : [0, 0, 1, 1];
  const flags = new Set<string>();

  const raw: Item[] = [];
  req.lines.forEach((l, i) => {
    if (!l || typeof l.text !== "string" || !finiteBox(l.b) || !centreIn(l.b, bbox)) return;
    if (l.text.trim() === "") return;
    raw.push({ i, parts: [i], l, x0: l.b[0], y0: l.b[1], y1: l.b[3], h: Math.max(l.b[3] - l.b[1], 1e-4) });
  });
  raw.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.i - b.i);
  const medianH = median(raw.map((it) => it.h), 0.01);
  const keyTol = o.keyColumnTolHeights * medianH;
  const items: Item[] = req.mode === "kv" ? raw : mergeKeyRows(raw, medianH);

  // columns
  let cuts = layoutBoundaries(req.layout, bbox);
  let layoutUsed = cuts !== null;
  if (cuts === null && items.length > 0) {
    const cx0 = Math.min(...items.map((it) => it.l.b[0]));
    const cx1 = Math.max(...items.map((it) => it.l.b[2]));
    const wide = SPANNING_WIDTH_SHARE * (cx1 - cx0);
    const ignore = (it: Item) => it.l.b[2] - it.l.b[0] > wide || (req.mode !== "kv" && matchHeader(it.l.text) !== null);
    cuts = gutterBoundaries(items, bbox, o.minGutterHeights * medianH, ignore);
  }
  if (cuts !== null && cuts.length > 0) flags.add("multi-column");
  if (layoutUsed) flags.add("layout-columns");
  const columns = columnBoxes(bbox, cuts ?? []);
  if (columns.length === 1) layoutUsed = false;
  const colOf = (it: Item): number => {
    const cx = (it.l.b[0] + it.l.b[2]) / 2;
    for (let k = 0; k < columns.length; k++) if (cx <= columns[k][2]) return k;
    return columns.length - 1;
  };
  // reading order: bands split at the lines that cross a cut; each band's columns left to right, then the spanning line
  const cutList = cuts ?? [];
  const spans = (it: Item) => cutList.some((c) => it.l.b[0] < c && it.l.b[2] > c);
  const segments: Item[][] = [];
  {
    let top = -Infinity;
    const spanning = items.filter(spans);
    const rest = items.filter((it) => !spans(it));
    for (const sp of [...spanning, null]) {
      const bottom = sp ? sp.y0 : Infinity;
      const byColumn: Item[][] = columns.map(() => []);
      for (const it of rest) if (it.y0 >= top && it.y0 < bottom) byColumn[colOf(it)].push(it);
      for (const col of byColumn) if (col.length > 0) segments.push(col);
      if (sp) {
        segments.push([sp]);
        top = sp.y0;
      }
    }
  }

  // state
  const blocks: BlockAcc[] = [];
  // state shared with the helpers below (an object, so TypeScript does not narrow it to null across the closures)
  const st: { block: BlockAcc | null; para: ParaAcc | null } = { block: null, para: null };
  let stack: StackEntry[] = [];
  let keyX: Partial<Record<KeyClass, number>> = {};
  let lastItem: Item | null = null;
  let nParas = 0;
  let specSection: string | undefined;
  let specSeen = false;
  let articles = 0;
  const forceKv = req.mode === "kv";
  const keyed = req.mode !== "kv";

  const openBlock = (header: HeaderMatch | null, headerItem: Item | null): BlockAcc => {
    const b: BlockAcc = { id: `b${blocks.length + 1}`, header, headerItem, lines: headerItem ? [headerItem] : [], paragraphs: [] };
    blocks.push(b);
    stack = [];
    keyX = {};
    st.para = null;
    return b;
  };
  const openPara = (it: Item, k: KeyMatch | null): void => {
    if (!st.block) st.block = openBlock(null, null);
    const p: ParaAcc = {
      id: `p${++nParas}`,
      key: k ? k.key : null,
      keyPath: k ? stack.map((e) => e.key) : [],
      depth: k ? Math.max(0, stack.length - 1) : 0,
      weak: k ? !k.strong : false,
      lines: [it],
      texts: [k ? k.rest : it.l.text.trim()],
      textX: textStartX(it, k),
    };
    st.block.paragraphs.push(p);
    st.block.lines.push(it);
    st.para = p;
  };
  const pushKey = (k: KeyMatch): void => {
    const idx = stack.map((e) => e.cls).lastIndexOf(k.cls);
    if (idx >= 0) stack = stack.slice(0, idx);
    stack.push({ cls: k.cls, key: k.key, ordinal: k.ordinal, group: k.group });
  };

  /** The open keyed paragraph wraps with a hanging indent, and `it` starts at that indent. */
  const atHangingIndent = (it: Item): boolean => {
    const p = st.para;
    if (!p || p.key === null) return false;
    const contX = p.lines.length >= 2 ? p.lines[1].x0 : p.textX;
    return contX - p.lines[0].x0 > keyTol && Math.abs(it.x0 - contX) <= keyTol;
  };

  for (const col of segments) {
    keyX = {};
    lastItem = null;
    for (const [ci, it] of col.entries()) {
      const text = it.l.text;
      let h = keyed ? matchHeader(text) : null;
      // MED-2: an all-caps wrapped line ending in NOTES / SPECIFICATIONS at the hanging indent, with no gap, is text
      if (h && lastItem && atHangingIndent(it) && it.y0 - lastItem.y1 <= o.paragraphGapHeights * medianH) h = null;
      if (h) {
        if (st.block && st.block.header === null && st.block.lines.length === 0) {
          st.block.header = h;
          st.block.headerItem = it;
          st.block.lines.push(it);
        } else st.block = openBlock(h, it);
        if (h.kind === "spec-section") {
          specSeen = true;
          if (specSection === undefined) specSection = h.section;
        } else if (h.kind === "spec-part") specSeen = true;
        if (h.continued) flags.add("continued");
        if (h.kind === "legend") flags.add("legend");
        lastItem = it;
        continue;
      }
      const k = keyed ? matchKey(text) : null;
      if (k) {
        const seq = inSequence(k, stack);
        const own = keyX[k.cls];
        const others = (Object.keys(keyX) as KeyClass[]).filter((c) => c !== k.cls).map((c) => keyX[c] as number);
        let accept: boolean;
        if (own !== undefined) {
          // the class has a key column: aligned keys follow the strong/weak rule; an unaligned in-sequence
          // strong key is accepted only when it is not at the open paragraph's text indent (MED-1)
          accept = Math.abs(it.x0 - own) <= keyTol ? k.strong || seq : k.strong && seq && !atHangingIndent(it);
        } else if (others.length === 0) {
          accept = k.strong || seq; // the first key column of this block / column
        } else {
          // a child level: indented right of its parent's key column and starting its sequence (MED-1)
          const parent = stack.length > 0 ? keyX[stack[stack.length - 1].cls] : undefined;
          const parentX = parent ?? Math.max(...others);
          accept = seq && it.x0 > parentX + keyTol;
          // a tag sub-list needs list evidence: "PT-1" in a wrapped line is a material mention (MED-1).
          // The parent's text introduces it (ends in ":"), or the next line continues the tag sequence.
          if (accept && k.cls === "tag") {
            const next = col[ci + 1] ? matchKey(col[ci + 1].l.text) : null;
            const listNext = next !== null && next.cls === "tag" && next.group === k.group && next.ordinal === k.ordinal + 1;
            const intro = st.para !== null && /:\s*$/.test(st.para.texts[st.para.texts.length - 1] ?? "");
            accept = listNext || intro;
          }
        }
        if (accept) {
          if (!st.block) st.block = openBlock(null, null); // before the key state: openBlock resets it
          pushKey(k);
          if (keyX[k.cls] === undefined) keyX[k.cls] = it.x0;
          if (k.cls === "article") articles++;
          if (!k.strong) flags.add("weak-keys");
          openPara(it, k);
          lastItem = it;
          continue;
        }
      }
      // plain text: continuation, or a new unkeyed paragraph after a gap / at a block start
      const gap = lastItem ? it.y0 - lastItem.y1 : 0;
      if (st.para && st.block && gap <= o.paragraphGapHeights * medianH) {
        st.para.lines.push(it);
        st.para.texts.push(text.trim());
        st.block.lines.push(it);
      } else openPara(it, null);
      lastItem = it;
    }
  }

  // kv blocks (K09): a block with no keys whose rows pair as key/value, or the whole region when forced
  const kvBlocks = forceKv ? blocks : req.mode === "keyed" ? [] : blocks.filter((b) => b.paragraphs.every((p) => p.key === null) && b.lines.length >= o.kvMinPairs);
  for (const b of kvBlocks) {
    const bodyLines = b.lines.filter((it) => it !== b.headerItem);
    if (bodyLines.length === 0) continue;
    const { pairs } = kvPairs(bodyLines.map((it) => it.l), { minGapRatio: o.kvMinGapRatio, maxKeyLen: o.kvMaxKeyLen, mergeContinuations: true });
    const withValue = pairs.filter((p) => p.value !== "").length;
    if (!forceKv && (withValue < o.kvMinPairs || withValue < 0.6 * pairs.length)) continue;
    b.paragraphs = pairs.map((p) => {
      const hasValue = p.value !== "";
      const acc: ParaAcc = {
        id: "",
        key: hasValue ? p.key : null,
        keyPath: hasValue ? [p.key] : [],
        depth: 0,
        weak: false,
        lines: p.lineIdx.map((k) => bodyLines[k]),
        texts: [hasValue ? p.value : p.key],
        textX: 0, // unused after accumulation
      };
      return acc;
    });
    flags.add("kv-pairs");
  }
  // an unkeyed paragraph before a keyed one in the same block is a lead-in (K35: kept, not dropped)
  for (const b of blocks) {
    const firstKeyed = b.paragraphs.findIndex((p) => p.key !== null);
    if (firstKeyed > 0) flags.add("lead-in");
  }
  // paragraph ids in reading order (kv blocks were re-made), and the per-line assignment
  let n = 0;
  const assignment: SegmentResult["assignment"] = [];
  for (const b of blocks) {
    if (b.headerItem) assignment.push({ line: b.headerItem.i, paragraph: null, header: b.id });
    for (const p of b.paragraphs) {
      p.id = `p${++n}`;
      for (const it of p.lines) for (const line of it.parts) assignment.push({ line, paragraph: p.id, header: null });
    }
  }
  assignment.sort((a, b) => a.line - b.line);

  // model
  const kind: "notes" | "spec" = req.kind ?? (specSeen || articles >= 2 ? "spec" : "notes");
  const outBlocks: ParagraphBlock[] = [];
  const outParas: Paragraph[] = [];
  let keyedLines = 0;
  for (const b of blocks) {
    const bb = unionBox(b.lines.map((it) => it.l.b));
    if (!bb) continue;
    const pb: ParagraphBlock = {
      id: b.id,
      header: b.header ? b.header.header : null,
      headerNorm: b.header ? b.header.headerNorm : null,
      b: clampBox(bb),
    };
    if (b.header?.continued) pb.continued = true;
    outBlocks.push(pb);
    if (b.headerItem) keyedLines++;
    for (const p of b.paragraphs) {
      const pbx = unionBox(p.lines.map((it) => it.l.b));
      if (!pbx) continue;
      if (p.key !== null) keyedLines += p.lines.length;
      let text = p.texts.filter((t) => t !== "").join(" ");
      if (text.length > PARSE_ENGINE_CAPS.paragraphText) {
        text = text.slice(0, PARSE_ENGINE_CAPS.paragraphText);
        flags.add("truncated");
      }
      outParas.push({
        id: p.id,
        blockId: b.id,
        key: p.key,
        keyPath: p.keyPath,
        keyNorm: normaliseKey(p.key),
        depth: p.depth,
        text,
        b: clampBox(pbx),
        lineCount: p.lines.length,
      });
    }
  }
  if (outParas.length > PARSE_ENGINE_CAPS.paragraphs) {
    outParas.length = PARSE_ENGINE_CAPS.paragraphs;
    flags.add("truncated");
    // the assignment names only paragraphs the doc keeps (VERIFY LOW-3)
    const kept = new Set(outParas.map((p) => p.id));
    for (const a of assignment) if (a.paragraph !== null && !kept.has(a.paragraph)) a.paragraph = null;
  }
  if (items.length === 0) flags.add("empty");
  if (outParas.every((p) => p.key === null)) flags.add("no-keys");

  const sources: MethodId[] = layoutUsed ? ["ocr-lines", "layout"] : ["ocr-lines"];
  const first = blocks[0];
  const title = first?.header && first.headerItem === items[0] && first.header.kind !== "spec-part" && first.header.kind !== "end-of-section"
    ? { text: first.header.header, src: "header-band" as const, conf: 0.9 }
    : undefined;
  const conf = items.length === 0 ? 0 : Math.min(1, 0.5 + 0.5 * (keyedLines / items.length));
  const doc: StructureParagraphDoc = {
    v: 1,
    kind,
    bbox: clampBox(bbox),
    ...(title ? { title } : {}),
    ...(kind === "spec" && specSection ? { spec: { section: specSection } } : {}),
    blocks: outBlocks,
    paragraphs: outParas,
    sources: { segment: sources },
    quality: { conf: Math.round(conf * 1000) / 1000, agreement: 1, flags: [...flags].sort() },
  };
  return { doc, assignment, columns };
}

/** Segment the lines inside `req.bbox` into a paragraph document (the automatic-stage entry point). */
export function segmentParagraphs(req: SegmentRequest, options: SegmentOptions = {}): StructureParagraphDoc {
  return segmentParagraphsDetailed(req, options).doc;
}
