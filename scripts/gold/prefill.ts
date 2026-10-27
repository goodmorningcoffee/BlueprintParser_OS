#!/usr/bin/env -S npx tsx
/**
 * prefill.ts — cut the page slices of a gold batch and prefill a first label for each unit (WP-2.G; PLAN §6.1).
 *
 *   NODE_OPTIONS=--max-old-space-size=3584 npx tsx scripts/gold/prefill.ts --batch b1 [--private-dir <dir>] [--corpus <corpus_v2>] [--force]
 *
 * For every unit of <dir>/gold/batches/<batch>/sample.json:
 *   - the slice <dir>/slices/prv-<goldId>.json (`bp-parse-fixture/1`, synthetic:false): the page's words, lines and
 *     Textract tables around the region, its tag shapes (yolo primitives + classical shape-parse with the crop read),
 *     and Guided / Manual inputs from detectRowsAndColumns — the same cut as the 2.0a private slices;
 *   - a prefill line in <dir>/gold/batches/<batch>/prefill.jsonl (`bp-gold/1`, adjudicated:false, mode "prefill"):
 *     G-TAB from Textract silver (the table method), else the legacy merger; G-PARA from the notes binder, else the
 *     spec binder; G-TAGMAP lists the table's tag-column keys with no instances (the labeller finds them; "?" when the
 *     table prefill has no keys).
 * Existing slices are kept unless --force. A unit with no page evidence (bundle or page absent, no Textract words or
 * lines) is skipped, and so is every G-TAGMAP unit whose table was skipped (it would name a table the batch lacks);
 * both are counted in the summary line. Reads only the corpus; writes only under the private dir. Prints counts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TextractLine, TextractTable, TextractWord } from "@/types";
import { runLegacyPath, type LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import { detectRowsAndColumns } from "@/lib/ocr-grid-detect";
import { DEFAULT_CORPUS, sheetNumberOf } from "../lib/corpus-v2-marks";
import { legacyPrediction } from "../lib/parse-measure";
import type { Sample, SampleItem } from "./select-sample";
import { argOf, privateDirOf, toJsonl, validateRecords, writePrivate, type GoldLine, type TabTruth } from "./gold-lib";

type MinMax = [number, number, number, number];
const SHAPE_LABELS = new Set(["circle", "hexagon", "diamond", "square", "triangle", "arch_sheet_circle", "oval", "pill", "rectangle", "dot_small_circle"]);
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const clamp = (v: number): number => Math.max(0, Math.min(1, v));
const centreInLtwh = (b: readonly number[], r: MinMax): boolean => { const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2; return cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]; };

interface BundleAnn { id: number; pageNumber: number; source: string; name: string; bbox?: number[]; threshold?: number; data?: { modelName?: string; shapeType?: string; text?: string; confidence?: number } | null }
interface BundlePage { pageNumber: number; textractData?: { words?: TextractWord[]; lines?: TextractLine[]; tables?: TextractTable[] } | null }
interface Bundle { pages?: BundlePage[]; annotations?: BundleAnn[] }

export interface SliceFile extends LegacySlice { schema: "bp-parse-fixture/1"; synthetic: false; title: string; kind: string; probes: string[]; truth: { type: "items"; items: [] } }

/** The private slice of one unit: page evidence in a 5 % context ring, shapes, and proposal-drawn Guided/Manual inputs. */
export function cutSlice(id: string, stratum: string, region: MinMax, page: BundlePage, anns: readonly BundleAnn[]): SliceFile | null {
  const td = page.textractData;
  if (!td?.words?.length || !td.lines?.length) return null;
  const ctx: MinMax = [region[0] - 0.05, region[1] - 0.05, region[2] + 0.05, region[3] + 0.05];
  const words = td.words.filter((w) => w?.bbox?.length === 4 && centreInLtwh(w.bbox, ctx));
  const lines = td.lines.filter((l) => l?.bbox?.length === 4 && centreInLtwh(l.bbox, ctx));
  const tables = (td.tables ?? []).filter((t) => t?.bbox && !(t.bbox[0] > ctx[2] || t.bbox[0] + t.bbox[2] < ctx[0] || t.bbox[1] > ctx[3] || t.bbox[1] + t.bbox[3] < ctx[1]));
  const shapes = anns.filter((a) => a.pageNumber === page.pageNumber && a.bbox?.length === 4
    && ((a.source === "yolo" && a.data?.modelName === "yolo_primitive" && SHAPE_LABELS.has(a.name)) || a.source === "shape-parse")
    && centreInLtwh([a.bbox[0], a.bbox[1], a.bbox[2] - a.bbox[0], a.bbox[3] - a.bbox[1]], ctx))
    .map((a) => ({
      label: a.source === "shape-parse" ? (a.data?.shapeType ?? a.name) : a.name,
      bbox: a.bbox!.map(r5) as MinMax,
      source: a.source === "shape-parse" ? ("classical" as const) : ("yolo" as const),
      confidence: a.data?.confidence ?? a.threshold ?? 0.5,
      ...(a.source === "shape-parse" && a.data?.text ? { text: a.data.text } : {}),
    }));
  const prop = detectRowsAndColumns(td.words, region);
  const rows = prop.rowBoundaries ?? [], cols = prop.colBoundaries ?? [];
  return {
    schema: "bp-parse-fixture/1", id, synthetic: false, title: `private ${stratum} gold slice`, kind: stratum, probes: [],
    page: { words, lines, tables }, shapes, region: region.map(r5) as MinMax,
    manual: { columnBBs: cols.slice(0, -1).map((x, i) => [x, region[1], cols[i + 1], region[3]] as MinMax), rowBBs: rows.slice(0, -1).map((y, i) => [region[0], y, region[2], rows[i + 1]] as MinMax), columnNames: [] },
    guided: { rows, cols },
    truth: { type: "items", items: [] },
  };
}

const PLACEHOLDER_HEADER = /^(Column \d+|Column [A-Z]|Col\d+|Key|Note|Value)$/;
const okEdges = (e: unknown, n: number): e is number[] => Array.isArray(e) && e.length === n && e.every((v, i) => typeof v === "number" && v >= 0 && v <= 1 && (i === 0 || v > e[i - 1]));

/** A table prefill from one method result (`{headers, rows, colBoundaries?, rowBoundaries?}`), or null when empty. */
export function tabTruthFrom(out: unknown, path: Parameters<typeof legacyPrediction>[0]): TabTruth | null {
  const grid = legacyPrediction(path, out).grid?.filter((r) => r.some((c) => c.trim())) ?? [];
  if (!grid.length) return null;
  const o = (out ?? {}) as { headers?: string[]; colBoundaries?: number[]; rowBoundaries?: number[] };
  const headers = [...new Set(o.headers ?? [])];
  const realHeader = headers.length > 0 && headers.some((h) => !PLACEHOLDER_HEADER.test(h));
  const ncols = Math.max(realHeader ? headers.length : 0, ...grid.map((r) => r.length));
  const pad = (r: readonly string[]) => [...r, ...new Array<string>(Math.max(0, ncols - r.length)).fill("")];
  const headerRows = realHeader ? [pad(headers)] : [];
  const t: TabTruth = { headerRows, rows: grid.map((cells) => ({ cells: pad(cells) })) };
  if (okEdges(o.colBoundaries, ncols + 1)) t.colEdges = o.colBoundaries;
  if (okEdges(o.rowBoundaries, headerRows.length + grid.length + 1)) t.rowEdges = o.rowBoundaries;
  return t;
}

/** The prefill line of one unit (never empty: a unit nothing could read gets one blank row / item to correct). */
export function prefillLine(item: SampleItem, slice: LegacySlice | null, sheet: string | null, tables: ReadonlyMap<string, TabTruth>): GoldLine {
  const common = { schema: "bp-gold/1" as const, goldId: item.goldId, setId: item.setId, page: item.page, sheet, stratum: item.stratum, adjudicated: false, protocol: "v1" as const, mode: "prefill" as const, region: item.region as MinMax };
  if (item.gold !== "G-TAGMAP" && !slice) throw new Error(`${item.goldId}: a ${item.gold} prefill needs its slice`);
  if (item.gold === "G-TAB" && slice) {
    const tx = tabTruthFrom(runLegacyPath("textract", slice), "textract");
    const truth = tx ?? tabTruthFrom(runLegacyPath("merger", slice), "merger") ?? { headerRows: [], rows: [{ cells: [""] }] };
    return { ...common, sliceId: slice.id, gold: "G-TAB", labellers: [tx ? "prefill:textract" : "prefill:merger"], truth };
  }
  if (item.gold === "G-PARA" && slice) {
    for (const path of ["notes-auto", "spec-auto"] as const) {
      const items = legacyPrediction(path, runLegacyPath(path, slice)).items?.filter((x) => (x.key + x.text).trim());
      if (items?.length) return { ...common, sliceId: slice.id, gold: "G-PARA", labellers: [`prefill:${path}`], truth: { items } };
    }
    return { ...common, sliceId: slice.id, gold: "G-PARA", labellers: ["prefill:none"], truth: { items: [{ key: "", text: "" }] } };
  }
  const table = tables.get(item.table ?? "");
  const tagCol = table?.tagColumn ?? 0;
  const keys = [...new Set((table?.rows ?? []).map((r) => (r.cells[tagCol] ?? "").trim()).filter(Boolean))];
  return {
    ...common, gold: "G-TAGMAP", labellers: ["prefill:tag-column"],
    truth: { table: item.table ?? "", scope: item.stratum === "keynote-sheet" ? "sheet" : "project", tags: (keys.length ? keys : ["?"]).map((tag) => ({ tag, instances: [] })) },
  };
}

export function main(argv: readonly string[]): number {
  const batch = argOf(argv, "batch");
  if (!batch) { console.error("usage: prefill.ts --batch <b1> [--private-dir d] [--corpus c] [--force]"); return 2; }
  const privateDir = privateDirOf(argOf(argv, "private-dir"));
  const corpus = argOf(argv, "corpus") ?? DEFAULT_CORPUS;
  const dir = join(privateDir, "gold", "batches", batch);
  const sample = JSON.parse(readFileSync(join(dir, "sample.json"), "utf8")) as Sample;
  const force = argv.includes("--force");
  const lines: GoldLine[] = [];
  const tables = new Map<string, TabTruth>();
  let cut = 0, kept = 0, noEvidence = 0, orphanTagMaps = 0;
  const skippedTables = new Set<string>();
  const cache: { pid: string | null; b: Bundle } = { pid: null, b: {} }; // one bundle in memory at a time (units are sorted by pid)
  const order = sample.items.slice().sort((a, b) => (a.gold === "G-TAGMAP" ? 1 : 0) - (b.gold === "G-TAGMAP" ? 1 : 0) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0) || (a.goldId < b.goldId ? -1 : 1));
  for (const item of order) {
    const sheet = sheetNumberOf(item.pid, item.page, corpus);
    if (item.gold === "G-TAGMAP") {
      // tag maps sort after every table, so a skipped table is known here
      if (item.table && skippedTables.has(item.table)) { orphanTagMaps++; continue; }
      lines.push(prefillLine(item, null, sheet, tables));
      continue;
    }
    const id = `prv-${item.goldId}`;
    const file = join(privateDir, "slices", `${id}.json`);
    let slice: LegacySlice | null = null;
    if (existsSync(file) && !force) { slice = JSON.parse(readFileSync(file, "utf8")) as LegacySlice; kept++; }
    else {
      if (cache.pid !== item.pid) {
        const bf = join(corpus, "data", "bundles", `${item.pid}.json`);
        cache.pid = item.pid;
        cache.b = existsSync(bf) ? (JSON.parse(readFileSync(bf, "utf8")) as Bundle) : {};
      }
      const page = cache.b.pages?.find((p) => p.pageNumber === item.page);
      const region = item.region.map(clamp) as MinMax;
      const s = page ? cutSlice(id, item.stratum, region, page, cache.b.annotations ?? []) : null;
      if (!s) { noEvidence++; if (item.gold === "G-TAB") skippedTables.add(item.goldId); continue; }
      writePrivate(file, JSON.stringify(s) + "\n", privateDir);
      slice = s;
      cut++;
    }
    const line = prefillLine(item, slice, sheet, tables);
    if (line.gold === "G-TAB") tables.set(line.goldId, line.truth);
    lines.push(line);
  }
  const { problems } = validateRecords(lines);
  if (problems.length) { console.error(`prefill: ${problems.length} schema problems (first: ${problems[0]})`); return 1; }
  lines.sort((a, b) => (a.goldId < b.goldId ? -1 : 1));
  writePrivate(join(dir, "prefill.jsonl"), toJsonl(lines), privateDir);
  console.log(`prefill: ${lines.length} prefill lines (${cut} slices cut, ${kept} kept, ${noEvidence} units without page evidence, ${orphanTagMaps} tag maps skipped with their table) → ${join(dir, "prefill.jsonl")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
