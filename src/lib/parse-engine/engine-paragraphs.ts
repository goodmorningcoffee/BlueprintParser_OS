/**
 * Paragraph assembly (table pipeline WP-3.D; PLAN §1.4, §2.1 paragraph model; WP-3.C hand-off). Server-side, pure,
 * deterministic (E-7).
 *
 * `kind: "notes" | "spec"` = `paragraphs/segment.ts` over the page's lines (`linesFromEvidence`) for each box
 * (`[bbox, ...parts]`, R11 continuation boxes), the boxes' documents joined in part order:
 * - block and paragraph ids are minted again across the parts (`b1…`, `p1…`), then re-matched to `request.prior`
 *   at box IoU ≥ .5 (`assemble.ts`), so ops keyed by `p<n>` land on a re-parse (§2.1 "Ids");
 * - the first block of a later part continues the last block of the part before it when it has no header of its own
 *   (`continued: true`, the `(CONT.)` rule of `segment.ts` across the box seam);
 * - the title is the segmenter's (a block header at the top), else the printed title (`title.ts`);
 * - flags and sources are the union; conf is the mean over the parts; a paid Textract crop's words stand in for the
 *   page words only when the page has none in the box (a scanned page).
 */

import { rematchBoxes } from "./assemble";
import { centreIn } from "./geometry";
import { linesFromEvidence, segmentParagraphsDetailed } from "./paragraphs/segment";
import {
  PARSE_ENGINE_CAPS,
  type BboxMinMax,
  type EnginePageEvidence,
  type MethodId,
  type ParagraphBlock,
  type Paragraph,
  type ParseRequest,
  type StructureParagraphDoc,
  type StructureTitle,
} from "./types";
import type { CropTextractEvidence } from "./types-crop";

export const PARAGRAPH_ASSEMBLY_VERSION = 1;

export interface ParagraphParseInput {
  ev: EnginePageEvidence;
  request: ParseRequest;
  /** Absent → the segmenter decides (a SECTION/PART header or two spec articles → spec). */
  kind?: "notes" | "spec";
  title?: StructureTitle;
  textractCrop?: CropTextractEvidence;
}

export interface ParagraphParseOutput {
  doc: StructureParagraphDoc;
  words: { t: string; b: BboxMinMax }[];
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function priorDoc(request: ParseRequest): StructureParagraphDoc | null {
  const p = request.prior;
  return p && (p.kind === "notes" || p.kind === "spec") ? p : null;
}

/** Parse a notes / spec box (see the file header). */
export function parseParagraphs(input: ParagraphParseInput): ParagraphParseOutput {
  const { request } = input;
  const boxes: BboxMinMax[] = [request.bbox, ...(request.parts ?? []).slice(0, PARSE_ENGINE_CAPS.parts)];
  let ev = input.ev;
  const pageHasWords = ev.words.some((w) => boxes.some((b) => centreIn(w.b, b)));
  if (!pageHasWords && input.textractCrop?.words.length) ev = { ...ev, words: input.textractCrop.words, lines: input.textractCrop.lines };
  const lines = linesFromEvidence(ev);
  const docs = boxes.map((bbox) => segmentParagraphsDetailed({ bbox, lines, layout: ev.layout, ...(input.kind ? { kind: input.kind } : {}) }).doc);
  const kind = input.kind ?? (docs.some((d) => d.kind === "spec") ? "spec" : "notes");

  const blocks: ParagraphBlock[] = [];
  const paragraphs: Paragraph[] = [];
  const flags = new Set<string>();
  const sources = new Set<MethodId>();
  docs.forEach((d, k) => {
    const blockId = new Map<string, string>();
    d.blocks.forEach((b, i) => {
      const id = `b${blocks.length + 1}`;
      blockId.set(b.id, id);
      const out: ParagraphBlock = { ...b, id };
      if (k > 0 && i === 0 && !b.header && blocks.length) out.continued = true;
      blocks.push(out);
    });
    for (const p of d.paragraphs) paragraphs.push({ ...p, id: `p${paragraphs.length + 1}`, blockId: blockId.get(p.blockId) ?? p.blockId });
    d.quality.flags.forEach((f) => flags.add(f));
    d.sources.segment.forEach((s) => sources.add(s));
  });
  if (docs.length > 1) flags.add("parts");

  // ids re-matched to the prior parse (blocks first, so paragraphs keep pointing at their block)
  // A corrected prior is matched through its `opsBase` (the machine boxes its ops were recorded on), and its own ids
  // stay reserved, so a replayed `split-paragraph` mints the same id again (WP-3.D verify HIGH-1).
  const prior = priorDoc(request);
  if (prior) {
    const base = prior.opsBase ?? prior;
    const bIds = rematchBoxes(blocks, base.blocks, "b", prior.blocks.map((b) => b.id));
    const bMap = new Map(blocks.map((b, i) => [b.id, bIds[i]]));
    blocks.forEach((b, i) => { b.id = bIds[i]; });
    const pIds = rematchBoxes(paragraphs, base.paragraphs, "p", prior.paragraphs.map((p) => p.id));
    paragraphs.forEach((p, i) => { p.id = pIds[i]; p.blockId = bMap.get(p.blockId) ?? p.blockId; });
  }
  if (paragraphs.length > PARSE_ENGINE_CAPS.paragraphs) {
    paragraphs.length = PARSE_ENGINE_CAPS.paragraphs;
    flags.add("truncated");
  }
  const first = docs[0];
  const title = first?.title ?? input.title;
  const spec = docs.find((d) => d.spec?.section)?.spec;
  const doc: StructureParagraphDoc = {
    v: 1,
    kind,
    bbox: request.bbox,
    ...(title ? { title } : {}),
    ...(kind === "spec" && spec ? { spec } : {}),
    blocks,
    paragraphs,
    sources: { segment: [...sources].sort() },
    quality: {
      conf: r3(docs.reduce((s, d) => s + d.quality.conf, 0) / Math.max(1, docs.length)),
      agreement: 1,
      flags: [...flags].sort(),
    },
  };
  const words = ev.words.filter((w) => boxes.some((b) => centreIn(w.b, b))).map((w) => ({ t: w.t, b: w.b }));
  return { doc, words };
}
