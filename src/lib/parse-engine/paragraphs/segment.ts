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
 * - Columns: Textract LAYOUT `list`/`text` blocks inside the box when present, else vertical gutters that
 *   no LINE crosses, with content on both sides; an empty run at the box edge is slack, not a gutter
 *   (K33). Columns read left to right, numbering continues across them.
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

/** Column boundaries at vertical gutters no LINE crosses, with ≥ 2 lines on each side; edge runs are slack. */
function gutterBoundaries(items: readonly Item[], bbox: Box, minGutter: number): number[] | null {
  const w = bbox[2] - bbox[0];
  if (w <= 0 || items.length < 2 * MIN_LINES_PER_COLUMN) return null;
  const cover = new Array<number>(GUTTER_BINS).fill(0);
  const binOf = (x: number) => Math.min(GUTTER_BINS - 1, Math.max(0, Math.floor(((x - bbox[0]) / w) * GUTTER_BINS)));
  for (const it of items) {
    const a = binOf(it.l.b[0]);
    const z = binOf(it.l.b[2]);
    for (let k = a; k <= z; k++) cover[k]++;
  }
  const cuts: number[] = [];
  let run = -1;
  const consider = (start: number, end: number) => {
    if (start <= 0 || end >= GUTTER_BINS - 1) return; // touches an edge: box slack (K33)
    const x0 = bbox[0] + (start / GUTTER_BINS) * w;
    const x1 = bbox[0] + ((end + 1) / GUTTER_BINS) * w;
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
  for (let k = 0; k < GUTTER_BINS; k++) {
    if (cover[k] === 0) {
      if (run < 0) run = k;
    } else if (run >= 0) {
      consider(run, k - 1);
      run = -1;
    }
  }
  if (run >= 0) consider(run, GUTTER_BINS - 1);
  return cuts.length > 0 ? cuts : null;
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
  if (k.cls === "tag") return k.strong;
  return k.ordinal === 1;
}

export function segmentParagraphsDetailed(req: SegmentRequest, options: SegmentOptions = {}): SegmentResult {
  const o = { ...DEFAULTS, ...options };
  const bbox: Box = finiteBox(req.bbox) ? req.bbox : [0, 0, 1, 1];
  const flags = new Set<string>();

  const items: Item[] = [];
  req.lines.forEach((l, i) => {
    if (!l || typeof l.text !== "string" || !finiteBox(l.b) || !centreIn(l.b, bbox)) return;
    if (l.text.trim() === "") return;
    items.push({ i, l, x0: l.b[0], y0: l.b[1], y1: l.b[3], h: Math.max(l.b[3] - l.b[1], 1e-4) });
  });
  items.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || a.i - b.i);
  const medianH = median(items.map((it) => it.h), 0.01);

  // columns
  let cuts = layoutBoundaries(req.layout, bbox);
  let layoutUsed = cuts !== null;
  if (cuts === null) cuts = gutterBoundaries(items, bbox, o.minGutterHeights * medianH);
  if (cuts !== null && cuts.length > 0) flags.add("multi-column");
  if (layoutUsed) flags.add("layout-columns");
  const columns = columnBoxes(bbox, cuts ?? []);
  if (columns.length === 1) layoutUsed = false;
  const colOf = (it: Item): number => {
    const cx = (it.l.b[0] + it.l.b[2]) / 2;
    for (let k = 0; k < columns.length; k++) if (cx <= columns[k][2]) return k;
    return columns.length - 1;
  };
  const byColumn: Item[][] = columns.map(() => []);
  for (const it of items) byColumn[colOf(it)].push(it);

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

  for (const col of byColumn) {
    keyX = {};
    lastItem = null;
    for (const it of col) {
      const text = it.l.text;
      const h = keyed ? matchHeader(text) : null;
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
        const aligned = keyX[k.cls] === undefined || Math.abs(it.x0 - (keyX[k.cls] as number)) <= o.keyColumnTolHeights * medianH;
        const seq = inSequence(k, stack);
        const accept = k.strong ? aligned || seq : aligned && seq;
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
      for (const it of p.lines) assignment.push({ line: it.i, paragraph: p.id, header: null });
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
