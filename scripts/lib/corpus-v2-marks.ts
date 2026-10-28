/**
 * scripts/lib/corpus-v2-marks.ts — the corpus_v2 page loader shared by region-classifier-v2-parity.ts
 * and classifier-measure.ts: `data/runs/<pid>/pages/page_NNNN.marks.json` (+ `.ytext.json`) → the
 * detections / Textract-shaped words / csiCodes the TS classifiers take. Textract tables are not in
 * the marks (bundle-only). Projects are reported as "set N"; nothing here prints OCR text.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BboxMinMax, CsiCode, KeynoteShapeData, TextractTable, TextractWord } from "@/types";
import type { RegionDetection } from "@/lib/region-classifier-v2";

export interface Mark {
  channel: string; label: string; bbox: BboxMinMax; center: [number, number]; confidence?: number;
  provenance?: string; text?: string | null; meta?: { modelName?: string; division?: string; annotationId?: number | null } | null;
}
export interface SamplePage { pid: string; set: number; page: number; run: string }

export const DEFAULT_CORPUS = "/workspaces/projects/gitignore/corpus_v2";
export const DEFAULT_RESEARCH = "/workspaces/projects/gitignore/projects/master_plan_2026-10-24/research/regions";

export const modelOf = (m: Mark): string => m.meta?.modelName ?? (m.provenance ?? "").split(":")[0].split(".").pop() ?? "";

const sheetCache = new Map<string, Map<number, string>>();
/** `data/runs/<pid>/sheets.json` → the page's drawing number (what production holds in `pages.drawingNumber`); null when absent. */
export function sheetNumberOf(pid: string, page: number, corpus = DEFAULT_CORPUS): string | null {
  let m = sheetCache.get(pid);
  if (!m) {
    m = new Map();
    const file = join(corpus, "data", "runs", pid, "sheets.json");
    if (existsSync(file)) {
      try {
        for (const r of JSON.parse(readFileSync(file, "utf8")) as Array<{ page?: number; drawingNumber?: string | null }>) {
          if (typeof r?.page === "number" && typeof r.drawingNumber === "string" && r.drawingNumber.trim()) m.set(r.page, r.drawingNumber.trim());
        }
      } catch { /* malformed → no sheet numbers for this run */ }
    }
    sheetCache.set(pid, m);
  }
  return m.get(page) ?? null;
}
export const minMaxToLtwh = (b: BboxMinMax): [number, number, number, number] => [b[0], b[1], b[2] - b[0], b[3] - b[1]];

export function readSample(research = DEFAULT_RESEARCH): SamplePage[] {
  return JSON.parse(readFileSync(join(research, "sample.json"), "utf8")) as SamplePage[];
}

export interface LoadedPage {
  marks: Mark[];
  yolo: Mark[];
  detections: RegionDetection[];
  words: TextractWord[];
  csiCodes: CsiCode[];
  /** The sheet number from the run's sheets.json (null when the run has none). */
  drawingNumber: string | null;
  /** [shape-tags] Classical shape-parse marks (channel "shape") as `pages.keynotes` rows: label, MinMax bbox, crop read. */
  keynotes: KeynoteShapeData[];
}

/** The page's marks as classifier inputs, or null when the marks file is absent. */
export function loadPage(s: SamplePage, corpus = DEFAULT_CORPUS): LoadedPage | null {
  const base = join(corpus, "data", "runs", s.pid, "pages", `page_${String(s.page).padStart(4, "0")}`);
  if (!existsSync(`${base}.marks.json`)) return null;
  let marks = JSON.parse(readFileSync(`${base}.marks.json`, "utf8")) as Mark[];
  if (existsSync(`${base}.ytext.json`)) marks = marks.concat(JSON.parse(readFileSync(`${base}.ytext.json`, "utf8")) as Mark[]);
  const yolo = marks.filter((m) => m.channel === "yolo");
  const detections: RegionDetection[] = yolo.map((m) => ({
    name: m.label, minX: m.bbox[0], minY: m.bbox[1], maxX: m.bbox[2], maxY: m.bbox[3], confidence: m.confidence ?? 0, modelName: modelOf(m),
  }));
  const words: TextractWord[] = marks.filter((m) => m.channel === "ocr").map((m) => ({ text: m.text ?? m.label ?? "", confidence: 99, bbox: minMaxToLtwh(m.bbox) }));
  const csiCodes: CsiCode[] = marks.filter((m) => m.channel === "csi").map((m) => ({
    code: m.label, description: "", trade: "", division: m.meta?.division ?? m.label,
    triggers: [{ text: "", tier: 1 as const, bbox: minMaxToLtwh(m.bbox) }],
  }));
  const keynotes: KeynoteShapeData[] = classicalKeynotes(s.pid, marks, corpus);
  return { marks, yolo, detections, words, csiCodes, drawingNumber: sheetNumberOf(s.pid, s.page, corpus), keynotes };
}

/**
 * [table-pipeline WP-2.G, K79] What a corpus bundle holds that the marks do not, parsed once per pid and kept small:
 * the Textract TABLES per page, and the classical crop read (`data.text`) of every shape-parse annotation by id.
 */
interface BundleIndex { tables: Map<number, TextractTable[]>; shapeText: Map<number, string>; textRegions: Map<number, CorpusTextRegion[]>; classified: Map<number, CorpusClassifiedSources> }
/** A System-1 text region from the bundle's `pageIntelligence.textRegions` (type + MinMax box only; no text kept). */
export interface CorpusTextRegion { type: string; bbox: BboxMinMax }
/** [table-pipeline WP-3.Q] The page's legacy table detections (`classifiedTables`, `ensembleRegions`; MinMax boxes + score only). */
export interface CorpusClassifiedSources { classifiedTables: { bbox: BboxMinMax; confidence: number }[]; ensembleRegions: { bbox: BboxMinMax; tableProbability: number }[] }
const bundleCache = new Map<string, BundleIndex>();
function bundleIndexOf(pid: string, corpus = DEFAULT_CORPUS): BundleIndex {
  const key = `${corpus}\u0000${pid}`;
  let ix = bundleCache.get(key);
  if (!ix) {
    ix = { tables: new Map(), shapeText: new Map(), textRegions: new Map(), classified: new Map() };
    const file = join(corpus, "data", "bundles", `${pid}.json`);
    if (existsSync(file)) {
      try {
        const bundle = JSON.parse(readFileSync(file, "utf8")) as {
          pages?: Array<{ pageNumber?: number; textractData?: { tables?: TextractTable[] } | null; pageIntelligence?: { textRegions?: Array<{ type?: unknown; bbox?: unknown }>; classifiedTables?: Array<{ bbox?: unknown; confidence?: unknown }>; ensembleRegions?: Array<{ bbox?: unknown; tableProbability?: unknown }> } | null }>;
          annotations?: Array<{ id?: number; source?: string; data?: { text?: unknown } | null }>;
        };
        for (const p of bundle.pages ?? []) {
          if (typeof p?.pageNumber === "number" && Array.isArray(p.textractData?.tables)) ix.tables.set(p.pageNumber, p.textractData.tables.filter((t) => t?.bbox));
          const trs = p?.pageIntelligence?.textRegions;
          if (typeof p?.pageNumber === "number" && Array.isArray(trs)) {
            ix.textRegions.set(p.pageNumber, trs.flatMap((t) => {
              const b = t?.bbox;
              if (typeof t?.type !== "string" || !Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === "number")) return [];
              return [{ type: t.type, bbox: [b[0], b[1], b[0] + b[2], b[1] + b[3]] as BboxMinMax }]; // textRegions are LTWH
            }));
          }
          // [WP-3.Q] classifiedTables / ensembleRegions are LTWH too (measured on the corpus: x + w ≤ 1)
          const ltwh = (b: unknown): BboxMinMax | null => (Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) ? [b[0], b[1], b[0] + b[2], b[1] + b[3]] as BboxMinMax : null);
          const pi = p?.pageIntelligence;
          if (typeof p?.pageNumber === "number" && pi && (Array.isArray(pi.classifiedTables) || Array.isArray(pi.ensembleRegions))) {
            ix.classified.set(p.pageNumber, {
              classifiedTables: (pi.classifiedTables ?? []).flatMap((t) => { const b = ltwh(t?.bbox); return b ? [{ bbox: b, confidence: typeof t.confidence === "number" ? t.confidence : 0 }] : []; }),
              ensembleRegions: (pi.ensembleRegions ?? []).flatMap((t) => { const b = ltwh(t?.bbox); return b ? [{ bbox: b, tableProbability: typeof t.tableProbability === "number" ? t.tableProbability : 0 }] : []; }),
            });
          }
        }
        for (const a of bundle.annotations ?? []) {
          if (a?.source === "shape-parse" && typeof a.id === "number") ix.shapeText.set(a.id, typeof a.data?.text === "string" ? a.data.text : "");
        }
      } catch { /* malformed bundle → no tables, no crop reads for this run */ }
    }
    bundleCache.set(key, ix);
  }
  return ix;
}

/**
 * [table-pipeline WP-2.G, K79] The page's classical shapes as production's `pages.keynotes` rows. Only classical shape-parse
 * marks (provenance `raster.opencv.shape:`) qualify: symbol-search template hits and other machine sources never enter
 * `pages.keynotes` in production. The ingest wrote `text = note || name` for shape-parse ANNOTATIONS, so their mark text is
 * the shape name ("circle"); the crop read is the bundle annotation's `data.text`. Marks cut from `pages.keynotes`
 * (no annotation id) already carry the crop read. When the bundle is absent, an annotation mark whose text is just its
 * label gets "" (unknown), never the shape name.
 */
export function classicalKeynotes(pid: string, marks: readonly Mark[], corpus = DEFAULT_CORPUS): KeynoteShapeData[] {
  const out: KeynoteShapeData[] = [];
  for (const m of marks) {
    if (m.channel !== "shape" || !(m.provenance ?? "").startsWith("raster.opencv.shape:")) continue;
    const annId = m.meta?.annotationId;
    let text = m.text ?? "";
    if (typeof annId === "number") {
      const crop = bundleIndexOf(pid, corpus).shapeText.get(annId);
      // an empty / blank crop read is unknown, not "": a later ingest's own text (not the shape name) then survives
      text = crop?.trim() ? crop : text === m.label ? "" : text;
    }
    out.push({ shape: m.label, text, bbox: m.bbox });
  }
  return out;
}

/**
 * [shape-tags] The page's Textract TABLES from the corpus bundle (`data/bundles/<pid>.json` → pages[].textractData.tables;
 * the marks do not carry them, production holds them in `pages.textractData.tables`). The bundle is parsed once per
 * pid and only its tables (and the shape crop reads, K79) are kept. Empty when the bundle is absent.
 */
export function textractTablesOf(pid: string, page: number, corpus = DEFAULT_CORPUS): TextractTable[] {
  return bundleIndexOf(pid, corpus).tables.get(page) ?? [];
}

/** [table-pipeline WP-3.Q] The page's legacy table detections from the bundle (MinMax); empty lists when absent. */
export function classifiedSourcesOf(pid: string, page: number, corpus = DEFAULT_CORPUS): CorpusClassifiedSources {
  return bundleIndexOf(pid, corpus).classified.get(page) ?? { classifiedTables: [], ensembleRegions: [] };
}

/** [table-pipeline WP-2.G] The page's System-1 text regions (type + MinMax) from the bundle; empty when absent. */
export function textRegionsOf(pid: string, page: number, corpus = DEFAULT_CORPUS): CorpusTextRegion[] {
  return bundleIndexOf(pid, corpus).textRegions.get(page) ?? [];
}
