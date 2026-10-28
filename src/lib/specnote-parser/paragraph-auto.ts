/**
 * Automatic notes stages on the paragraph engine (table pipeline WP-3.J; PLAN §3.5, C2-M1b).
 *
 * Under `tools.notesAuto = "engine"` the two automatic notes stages stop keeping private copies of the paragraph
 * rules and read through `parse-engine/paragraphs/segment.ts` (`segmentParagraphs`):
 *   - A03, the System-1 binders (`classifyTextRegions`): a `notes-numbered` region is segmented in `keyed` mode and a
 *     `notes-key-value` region in `kv` mode (K09), instead of `bindNumberedGrid` / `bindKeyValueGrid`; the stored
 *     `TextRegion.grid` is the paragraph model's legacy projection (`legacy-view.ts` E-5: `{Key, Note}` rows and
 *     closed row bands, K14 / C04-13), so a wrapped note stays one row (K31) and `2.5 MM` is text (K35);
 *   - A12, `detectNoteBlocks` (`page-analysis.ts`): the page is segmented once and every block that reads as a list
 *     of notes becomes a `NoteBlock`, so a block no longer ends at the first wrapped line and a sub-block header
 *     resets the numbering.
 *
 * The flag is never read here (rule: no `app_settings` in `lib`). The server caller reads `parseEngine` and passes
 * `{ notesAuto }` down (`processProject` options, the intelligence reprocess). Absent or `"legacy"` = the legacy
 * binders, byte-for-byte.
 *
 * Lines are built exactly as the engine's evidence loader builds them (words → `wordsToLines` with the same split
 * gap, `server/services/parse-engine/evidence.ts` `EVIDENCE_LINE_SPLIT_GAP`; a test pins the two constants equal),
 * so an automatic stage reads the same lines as a workspace parse of the same box. Pure and deterministic (E-7).
 */

import { ltwhToMinMax, minMaxToLtwh, unionBox } from "@/lib/parse-engine/geometry";
import { wordsToLines } from "@/lib/parse-engine/lines";
import { legacyView, type LegacyNotesView } from "@/lib/parse-engine/legacy-view";
import { matchHeader, matchKey } from "@/lib/parse-engine/paragraphs/keys";
import { segmentParagraphs, segmentParagraphsDetailed } from "@/lib/parse-engine/paragraphs/segment";
import type { BboxMinMax, EngineLayoutBlock, Paragraph, ParseEngineMode } from "@/lib/parse-engine/types";
import type { SegmentLine } from "@/lib/parse-engine/types-paragraphs";
import { TEXTRACT_LAYOUT_KINDS } from "@/types/shapes/textract";
import type { BboxLTWH, NoteBlock, TextractPageData } from "@/types";

/** The server-supplied option the automatic stages take (`tools.notesAuto`, read by the caller). */
export interface NotesAutoOption {
  notesAuto?: ParseEngineMode;
}

/** `EVIDENCE_LINE_SPLIT_GAP` (server-side evidence loader): × median word height. Pinned equal by a test. */
export const NOTES_AUTO_LINE_SPLIT_GAP = 1.2;

type Box = readonly [number, number, number, number];
const finite4 = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));
const LAYOUT_KINDS: ReadonlySet<string> = new Set(TEXTRACT_LAYOUT_KINDS);

export const isNotesAutoEngine = (opts: NotesAutoOption | null | undefined): boolean => opts?.notesAuto === "engine";

/** The page's lines and LAYOUT blocks as the segmenter reads them (MinMax, E-4). */
export interface NotesAutoPage {
  lines: SegmentLine[];
  layout?: EngineLayoutBlock[];
}

/** Textract page → segmenter lines (the evidence loader's words → lines rule) + the compact LAYOUT, when stored. */
export function notesAutoPage(textractData: TextractPageData | null | undefined): NotesAutoPage {
  const raw = Array.isArray(textractData?.words) ? textractData.words : [];
  const words = raw
    .filter((w) => w && typeof w.text === "string" && finite4(w.bbox))
    .map((w) => ({ t: w.text, b: ltwhToMinMax(w.bbox) as BboxMinMax }));
  const lines: SegmentLine[] = wordsToLines(words, { splitGap: NOTES_AUTO_LINE_SPLIT_GAP }).map((l) => ({
    text: l.text,
    b: l.b,
    words: l.wordIdx.map((i) => words[i]),
  }));
  const stored = (textractData as { layout?: unknown } | null | undefined)?.layout;
  const layout = Array.isArray(stored)
    ? stored.flatMap((l: unknown) => {
      const o = l as { k?: unknown; b?: unknown } | null;
      return o && typeof o.k === "string" && LAYOUT_KINDS.has(o.k) && finite4(o.b) ? [{ k: o.k, b: [...o.b] } as EngineLayoutBlock] : [];
    })
    : undefined;
  return layout ? { lines, layout } : { lines };
}

/** The `TextRegion.grid` shape (`{Key, Note}` rows; `rowBoundaries` are closed bands, N + 1 for N rows). */
export interface NotesAutoGrid {
  headers: string[];
  rows: Record<string, string>[];
  rowBoundaries?: number[];
}

/**
 * A03 on the engine: one classified notes region (LTWH, as `TextRegion.bbox`) → its grid, or undefined when the
 * segmenter finds no keyed paragraph (the legacy binders' "no rows" outcome).
 */
export function engineNotesGrid(page: NotesAutoPage, regionLtwh: BboxLTWH, regionType: "notes-numbered" | "notes-key-value"): NotesAutoGrid | undefined {
  const doc = segmentParagraphs({
    bbox: ltwhToMinMax(regionLtwh) as BboxMinMax,
    lines: page.lines,
    ...(page.layout ? { layout: page.layout } : {}),
    kind: "notes",
    mode: regionType === "notes-key-value" ? "kv" : "keyed",
  });
  if (!doc.paragraphs.some((p) => p.key !== null)) return undefined;
  const view = legacyView(doc) as LegacyNotesView;
  return { headers: [...view.headers], rows: view.rows, ...(view.rowBoundaries ? { rowBoundaries: view.rowBoundaries } : {}) };
}

/** A bare number or letter key gets its printed period back ("1." / "A."), as the legacy note lines read. */
function printedKey(key: string): string {
  return /^([A-Za-z]|\d+)$/.test(key) ? `${key}.` : key;
}

/**
 * A12 on the engine: the page's note blocks. The page is segmented once (`keyed`, notes). A block is a note block
 * when its first top-level keyed paragraph opens with a STRONG key (`1.`, `(1)`, `A.` — never a bare digit, so a
 * schedule's number column is not a note list) and either the block has a NOTES header or that first key is 1, and
 * it has at least two top-level keyed paragraphs (the legacy "2+ notes" rule). Each note is a top-level paragraph
 * with its sub-items folded in ("1. … A. … B. …"); unkeyed lead-ins are not notes. Title = the block header, else
 * "NOTES"; bbox = the header line and the notes (LTWH, as `NoteBlock.bbox`; lead-ins are outside it).
 */
export function engineNoteBlocks(page: NotesAutoPage): NoteBlock[] {
  const { doc, assignment } = segmentParagraphsDetailed({
    bbox: [0, 0, 1, 1],
    lines: page.lines,
    ...(page.layout ? { layout: page.layout } : {}),
    kind: "notes",
    mode: "keyed",
  });
  const firstLine = new Map<string, number>();
  const headerLine = new Map<string, number>();
  for (const a of assignment) {
    if (a.paragraph && !firstLine.has(a.paragraph)) firstLine.set(a.paragraph, a.line);
    if (a.header && !headerLine.has(a.header)) headerLine.set(a.header, a.line);
  }
  const strong = (p: Paragraph): boolean => {
    const i = firstLine.get(p.id);
    const m = i === undefined ? null : matchKey(page.lines[i]?.text ?? "");
    return !!m && m.strong;
  };

  const out: NoteBlock[] = [];
  for (const block of doc.blocks) {
    const notes: { root: Paragraph; text: string[]; boxes: Box[] }[] = [];
    for (const p of doc.paragraphs) {
      if (p.blockId !== block.id || p.key === null) continue;
      const line = `${printedKey(p.key)} ${p.text}`.trim();
      if (p.depth === 0) notes.push({ root: p, text: [line], boxes: [p.b] });
      else if (notes.length) {
        notes[notes.length - 1].text.push(line);
        notes[notes.length - 1].boxes.push(p.b);
      }
    }
    if (notes.length < 2 || !strong(notes[0].root)) continue;
    const notesHeader = block.header !== null && matchHeader(block.header)?.kind === "notes" && /\bNOTES?\b/.test(block.headerNorm ?? "");
    if (!notesHeader && notes[0].root.keyNorm !== "1") continue;
    const hi = headerLine.get(block.id);
    const header = hi === undefined ? [] : [page.lines[hi].b];
    const box = unionBox([...header, ...notes.flatMap((n) => n.boxes)]) ?? block.b;
    out.push({
      title: block.header ?? "NOTES",
      notes: notes.map((n) => n.text.join(" ")),
      bbox: minMaxToLtwh(box) as BboxLTWH,
      noteCount: notes.length,
    });
  }
  return out;
}
