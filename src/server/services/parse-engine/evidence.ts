/**
 * The ONE page-evidence loader (table pipeline PLAN §2.1, WP-2.E; K47).
 *
 * `loadPageEvidence(tx?, projectId, page)` reads one page, with single-key projections only (never
 * `textract_data->'lines'`), plus that page's YOLO rows, and returns `LoadedPageEvidence`:
 *   - the engine's normalised view (`EnginePageEvidence`, every box MinMax, E-4): words with a line id,
 *     visual lines, compact LAYOUT, Textract cells with spans and header flags, tag shapes (yolo_primitive
 *     and classical), primitives, other detections, stored proposal anchors, the sheet key and a hash;
 *   - `sources`: the raw slices exactly as the four hand-rolled classifier loaders build them
 *     (reprocess-classifiers.ts, classifier-preview.ts, reprocess.ts, yolo-post-enrichment.ts), so
 *     `toClassifierPageInput(ev)` hands the classifier engine the same input they do. Unlike the
 *     intelligence reprocess (K47) it always carries `channelKind`.
 * Server-only (`sources` holds raw OCR). Nothing calls it in TP-2; the parse service (TP-3) and the
 * classifier loaders (TP-5) move onto it.
 *
 * `buildPageEvidence(row)` is the pure half (tested without a DB). Deterministic (E-7): YOLO rows are
 * read in id order and the hash is over a key-sorted serialisation.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import type { ClassifierPageInput } from "@/lib/classifier-engine";
import { storedClassifierProposals } from "@/lib/classifier-engine/engine";
import type { PageZones } from "@/lib/page-zones";
import type { RegionDetection, RegionsV2 } from "@/lib/region-classifier-v2";
import { sheetKey } from "@/lib/shape-ensemble/text-rules";
import { assembleText, wordsToLines } from "@/lib/parse-engine/lines";
import { centreIn, ltwhToMinMax } from "@/lib/parse-engine/geometry";
import type {
  BboxMinMax,
  EngineLayoutBlock,
  EnginePageEvidence,
  EngineProposal,
  EngineShape,
  EngineTextractCell,
  EngineWord,
} from "@/lib/parse-engine/types";
import type { CsiCode, KeynoteShapeData, TextractTable, TextractWord } from "@/types";
import { TEXTRACT_LAYOUT_KINDS, type TextractLayoutKind } from "@/types/shapes/textract";
import { regionsV2OrCompute, storedChannelKind } from "@/server/services/reprocess-classifiers";
import { stableStringify } from "@/server/services/yolo-post-enrichment";

/** Line split gap (× median word height) — the csi-detect rule, passed explicitly (WP-2.0b VERIFY LOW-1). */
export const EVIDENCE_LINE_SPLIT_GAP = 1.2;
const PRIMITIVE_CLASSES = new Set(["grid", "horizontal_area", "vertical_area"]);
const PRIMITIVE_MODEL = "yolo_primitive";

/** The raw page slices, exactly as the classifier loaders pass them (server-only). */
export interface PageEvidenceSources {
  detections: RegionDetection[];
  zones: PageZones | undefined;
  textractData: { words: TextractWord[]; tables?: TextractTable[] } | null;
  csiCodes: CsiCode[];
  regionsV2: RegionsV2 | undefined;
  parsedRegions: ReadonlyArray<{ bbox?: readonly number[] | null }> | null | undefined;
  drawingNumber: string | null;
  channelKind: ClassifierPageInput["channelKind"];
  keynotes: readonly KeynoteShapeData[] | null;
}

export interface LoadedPageEvidence extends EnginePageEvidence {
  sources: PageEvidenceSources;
}

/** One page as `loadPageEvidence` selects it (each JSON slice is untrusted until checked here). */
export interface PageEvidenceRow {
  pageNumber: number;
  drawingNumber: string | null;
  keynotes: unknown;
  csiCodes: unknown;
  words: unknown;
  tables: unknown;
  layout: unknown;
  pageZones: unknown;
  regionsV2: unknown;
  parsedRegions: unknown;
  channels: unknown;
  classifierProposals: unknown;
  yolo: ReadonlyArray<{ name: string; minX: number; minY: number; maxX: number; maxY: number; data: unknown }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite4 = (b: unknown): b is [number, number, number, number] =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));
const LAYOUT_KINDS: ReadonlySet<string> = new Set(TEXTRACT_LAYOUT_KINDS);

function engineWords(words: readonly TextractWord[]): { words: EngineWord[]; lines: EnginePageEvidence["lines"] } {
  const kept = words.filter((w) => w && typeof w.text === "string" && finite4(w.bbox));
  const boxes = kept.map((w) => ltwhToMinMax(w.bbox));
  const lines = wordsToLines(kept.map((w, i) => ({ t: w.text, b: boxes[i] })), { splitGap: EVIDENCE_LINE_SPLIT_GAP });
  const lineOf = new Array<number>(kept.length).fill(-1);
  lines.forEach((l, li) => { for (const i of l.wordIdx) lineOf[i] = li; });
  return {
    words: kept.map((w, i) => ({
      t: w.text,
      b: boxes[i],
      conf: typeof w.confidence === "number" && Number.isFinite(w.confidence) ? Math.min(1, Math.max(0, w.confidence / 100)) : 0,
      lineId: lineOf[i],
    })),
    lines: lines.map((l) => ({ text: l.text, b: l.b, wordIdx: l.wordIdx })),
  };
}

function engineLayout(layout: unknown): EngineLayoutBlock[] | undefined {
  if (!Array.isArray(layout)) return undefined;
  return layout.flatMap((l) =>
    isObj(l) && typeof l.k === "string" && LAYOUT_KINDS.has(l.k) && finite4(l.b) ? [{ k: l.k as TextractLayoutKind, b: [...l.b] as BboxMinMax }] : [],
  );
}

/** Textract tables → MinMax cells, 0-based r/c; MERGED_CELL spans (when stored) widen the anchor cell. */
function engineTables(tables: readonly TextractTable[]): EnginePageEvidence["textractTables"] {
  const out: EnginePageEvidence["textractTables"] = [];
  for (const t of tables) {
    if (!t || !finite4(t.bbox) || !Array.isArray(t.cells)) continue;
    const merged = (t as { merged?: unknown }).merged;
    const span = new Map<string, { rs: number; cs: number }>();
    if (Array.isArray(merged)) {
      for (const m of merged) {
        if (isObj(m) && [m.r, m.c, m.rs, m.cs].every((v) => Number.isInteger(v) && (v as number) >= 1)) span.set(`${m.r}:${m.c}`, { rs: m.rs as number, cs: m.cs as number });
      }
    }
    const cells: EngineTextractCell[] = [];
    for (const c of t.cells) {
      if (!c || !finite4(c.bbox) || !Number.isInteger(c.row) || !Number.isInteger(c.col)) continue;
      const s = span.get(`${c.row}:${c.col}`);
      cells.push({
        r: c.row - 1,
        c: c.col - 1,
        rs: s?.rs ?? (Number.isInteger(c.rowSpan) && c.rowSpan >= 1 ? c.rowSpan : 1),
        cs: s?.cs ?? (Number.isInteger(c.colSpan) && c.colSpan >= 1 ? c.colSpan : 1),
        b: ltwhToMinMax(c.bbox),
        ...((c as { hdr?: unknown }).hdr === true ? { hdr: true as const } : {}),
      });
    }
    out.push({ b: ltwhToMinMax(t.bbox), cells });
  }
  return out;
}

function shapeText(words: readonly EngineWord[], b: BboxMinMax): string | null {
  const inside = words.filter((w) => centreIn(w.b, b));
  const text = inside.length ? assembleText(inside.map((w) => ({ t: w.t, b: w.b }))) : "";
  return text ? text : null;
}

function engineProposals(pageIntelligence: Record<string, unknown>): EngineProposal[] {
  const stored = storedClassifierProposals(pageIntelligence);
  if (!stored) return [];
  return stored.proposals.flatMap((p) => {
    if (!p || typeof p.id !== "string" || !finite4(p.bbox)) return [];
    const rows = p.tagMap?.rows?.filter((r) => r && finite4(r.shapeBbox) && finite4(r.rowBbox));
    return [{
      id: p.id,
      b: [...p.bbox] as BboxMinMax,
      classId: typeof p.classId === "string" ? p.classId : null,
      p: typeof p.p === "number" ? p.p : 0,
      ...(typeof p.tableP === "number" ? { tableP: p.tableP } : {}),
      ...(rows ? { tagMap: { rows: rows.map((r) => ({ tag: r.tag ?? null, shapeClass: r.shapeClass, shapeBbox: [...r.shapeBbox] as BboxMinMax, rowBbox: [...r.rowBbox] as BboxMinMax })) } } : {}),
    }];
  });
}

const overlaps = (a: readonly number[], b: readonly number[]): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * sha1 over the evidence slices that touch `bbox` (every slice when bbox is the page), plus the sheet key
 * and channel kind. A region's hash changes only when evidence near it changes; the page hash is
 * `regionEvidenceHash(ev, [0, 0, 1, 1])`.
 */
export function regionEvidenceHash(ev: Omit<EnginePageEvidence, "evidenceHash">, bbox: readonly number[]): string {
  const near = <T extends { b: readonly number[] }>(xs: readonly T[]) => xs.filter((x) => overlaps(x.b, bbox));
  const payload = {
    v: ev.v,
    sheet: ev.sheet.key,
    channelKind: ev.channelKind,
    words: near(ev.words).map((w) => [w.t, w.b, w.conf]),
    layout: ev.layout ? near(ev.layout) : null,
    textractTables: near(ev.textractTables),
    shapes: near(ev.shapes),
    primitives: near(ev.primitives),
    detections: near(ev.detections),
    proposals: near(ev.proposals),
  };
  return createHash("sha1").update(stableStringify(payload)).digest("hex");
}

/** The pure half of the loader: one selected page row → `LoadedPageEvidence`. */
export function buildPageEvidence(row: PageEvidenceRow): LoadedPageEvidence {
  // ── raw slices, mapped exactly as the classifier loaders map them ──
  const detections: RegionDetection[] = row.yolo.map((a) => {
    const data = a.data as { confidence?: number; modelName?: string } | null;
    return { name: a.name, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY, confidence: data?.confidence ?? 0, modelName: data?.modelName };
  });
  const textractData = Array.isArray(row.words)
    ? { words: row.words as TextractWord[], ...(row.tables ? { tables: row.tables as TextractTable[] } : {}) }
    : null;
  const csiCodes = (row.csiCodes ?? []) as CsiCode[];
  const pi: Record<string, unknown> = {
    pageZones: row.pageZones ?? undefined,
    regionsV2: row.regionsV2 ?? undefined,
    parsedRegions: row.parsedRegions ?? undefined,
    channels: row.channels ?? undefined,
    classifierProposals: row.classifierProposals ?? undefined,
  };
  const zones = (row.pageZones ?? undefined) as PageZones | undefined;
  const regionsV2 = regionsV2OrCompute(pi, { pageNumber: row.pageNumber, detections, zones, textractData, csiCodes }).regionsV2;
  const channelKind = storedChannelKind(pi);
  const keynotes = (row.keynotes ?? null) as readonly KeynoteShapeData[] | null;
  const sources: PageEvidenceSources = {
    detections, zones, textractData, csiCodes, regionsV2,
    parsedRegions: pi.parsedRegions as PageEvidenceSources["parsedRegions"],
    drawingNumber: row.drawingNumber, channelKind, keynotes,
  };

  // ── the engine's normalised view ──
  const { words, lines } = engineWords(textractData?.words ?? []);
  const shapes: EngineShape[] = [];
  const primitives: EnginePageEvidence["primitives"] = [];
  const others: EnginePageEvidence["detections"] = [];
  for (const d of detections) {
    const b: BboxMinMax = [d.minX, d.minY, d.maxX, d.maxY];
    if (!finite4(b) || b[2] <= b[0] || b[3] <= b[1]) continue;
    if (d.modelName === PRIMITIVE_MODEL && PRIMITIVE_CLASSES.has(d.name)) primitives.push({ b, cls: d.name as "grid" | "horizontal_area" | "vertical_area" });
    else if (d.modelName === PRIMITIVE_MODEL) {
      const text = shapeText(words, b);
      shapes.push({ b, cls: d.name, src: "yolo", text, textSrc: text === null ? null : "inside" });
    } else others.push({ b, model: d.modelName ?? "", cls: d.name, conf: d.confidence ?? 0 });
  }
  for (const k of keynotes ?? []) {
    if (!k || typeof k.shape !== "string" || !finite4(k.bbox)) continue;
    const b = [...k.bbox] as BboxMinMax;
    const inside = shapeText(words, b);
    const crop = typeof k.text === "string" && k.text.trim() ? k.text.trim() : null;
    shapes.push({ b, cls: k.shape, src: "classical", text: inside ?? crop, textSrc: inside !== null ? "inside" : crop !== null ? "crop" : null });
  }
  const layout = engineLayout(row.layout);
  const raw = typeof row.drawingNumber === "string" && row.drawingNumber.trim() ? row.drawingNumber.trim() : null;
  const base: Omit<EnginePageEvidence, "evidenceHash"> = {
    v: 1,
    page: row.pageNumber,
    sheet: { raw, key: sheetKey(raw) },
    channelKind,
    words,
    lines,
    ...(layout ? { layout } : {}),
    textractTables: engineTables(textractData?.tables ?? []),
    shapes,
    primitives,
    detections: others,
    ...(zones !== undefined ? { zones } : {}),
    proposals: engineProposals(pi),
  };
  return { ...base, evidenceHash: regionEvidenceHash(base, [0, 0, 1, 1]), sources };
}

/** The classifier engine's input for this page, as the four hand-rolled loaders build it (+ channelKind, K47). */
export function toClassifierPageInput(ev: LoadedPageEvidence): Omit<ClassifierPageInput, "tagger"> {
  const s = ev.sources;
  return {
    pageNumber: ev.page,
    detections: s.detections,
    zones: s.zones,
    textractData: s.textractData,
    csiCodes: s.csiCodes,
    regionsV2: s.regionsV2,
    parsedRegions: s.parsedRegions,
    drawingNumber: s.drawingNumber,
    channelKind: s.channelKind,
    keynotes: s.keynotes,
  };
}

type PageReader = Pick<typeof db, "select">;

/**
 * Load one page's evidence. `tx` (optional) reads inside a caller's transaction; heavy work never runs
 * inside a project write (rule 11), and this is a read. Returns null when the page does not exist.
 */
export async function loadPageEvidence(tx: PageReader | null | undefined, projectId: number, page: number): Promise<LoadedPageEvidence | null> {
  const q = tx ?? db;
  const [p] = await q
    .select({
      pageNumber: pages.pageNumber,
      drawingNumber: pages.drawingNumber,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
      words: sql<unknown>`${pages.textractData}->'words'`,
      tables: sql<unknown>`${pages.textractData}->'tables'`,
      layout: sql<unknown>`${pages.textractData}->'layout'`,
      pageZones: sql<unknown>`${pages.pageIntelligence}->'pageZones'`,
      regionsV2: sql<unknown>`${pages.pageIntelligence}->'regionsV2'`,
      parsedRegions: sql<unknown>`${pages.pageIntelligence}->'parsedRegions'`,
      channels: sql<unknown>`${pages.pageIntelligence}->'channels'`,
      classifierProposals: sql<unknown>`${pages.pageIntelligence}->'classifierProposals'`,
    })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, page)))
    .limit(1);
  if (!p) return null;
  const yolo = await q
    .select({ name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, data: annotations.data })
    .from(annotations)
    .where(and(eq(annotations.projectId, projectId), eq(annotations.source, "yolo"), eq(annotations.pageNumber, page)))
    .orderBy(asc(annotations.id));
  return buildPageEvidence({ ...p, yolo });
}
