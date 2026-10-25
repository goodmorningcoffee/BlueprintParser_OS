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
  provenance?: string; text?: string | null; meta?: { modelName?: string; division?: string } | null;
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
  const keynotes: KeynoteShapeData[] = marks.filter((m) => m.channel === "shape").map((m) => ({ shape: m.label, text: m.text ?? "", bbox: m.bbox }));
  return { marks, yolo, detections, words, csiCodes, drawingNumber: sheetNumberOf(s.pid, s.page, corpus), keynotes };
}

const tablesCache = new Map<string, Map<number, TextractTable[]>>();
/**
 * [shape-tags] The page's Textract TABLES from the corpus bundle (`data/bundles/<pid>.json` → pages[].textractData.tables;
 * the marks do not carry them, production holds them in `pages.textractData.tables`). The bundle is parsed once per
 * pid and only its tables are kept. Empty when the bundle is absent.
 */
export function textractTablesOf(pid: string, page: number, corpus = DEFAULT_CORPUS): TextractTable[] {
  let m = tablesCache.get(pid);
  if (!m) {
    m = new Map();
    const file = join(corpus, "data", "bundles", `${pid}.json`);
    if (existsSync(file)) {
      try {
        const bundle = JSON.parse(readFileSync(file, "utf8")) as { pages?: Array<{ pageNumber?: number; textractData?: { tables?: TextractTable[] } | null }> };
        for (const p of bundle.pages ?? []) {
          if (typeof p?.pageNumber === "number" && Array.isArray(p.textractData?.tables)) m.set(p.pageNumber, p.textractData.tables.filter((t) => t?.bbox));
        }
      } catch { /* malformed bundle → no tables for this run */ }
    }
    tablesCache.set(pid, m);
  }
  return m.get(page) ?? [];
}
