/**
 * legacy-paths.ts — the legacy parse paths as pure adapters over one page slice (table-pipeline WP-2.0a).
 *
 * Each adapter replays what a classic tool computes, with the same inputs the tool would have, so
 * the goldens (`lib/parse-engine/__tests__/legacy-golden*.test.ts`) and the measurement script (WP-2.G)
 * can run every path on a fixture without a browser, a route or a database. Server/test/script use
 * only: it reaches `lib/services/table-parse.ts`, which imports node modules. Client code imports
 * the individual joins (`./keynote-manual`, `./manual-cells`, `./notes-manual`, `./notes-fast-manual`).
 *
 * The adapters mirror, at the TP-1 head (67492cc):
 *   ocr-positions     POST /api/table-parse → methodOcrPositions
 *   textract          POST /api/table-parse → methodTextractTables
 *   shape-rows        POST /api/table-parse {rowSource:"shape-centres"} → methodShapeRows
 *   merger            mergeGrids over the three offline methods (opencv / img2table need Python)
 *   guided-extract    Table Guided: /propose → detectRowsAndColumns, then extractCellsFromGrid on the
 *                     proposal and on the user's final lines
 *   manual            Table Manual → joinManualCells
 *   keynote-manual    Keynote Manual → joinKeynoteIntersections
 *   keynote-guided    Keynote Guided → extractCellsFromGrid + the KeynoteData it saves
 *   notes-auto        /api/notes-parse → parseNotesFromRegion
 *   notes-guided      Notes Guided: /api/notes-parse/propose → extractCellsFromGrid
 *   notes-paragraph   Paragraph overlay fallback clusters (notes tolerance) → rowTextFromClusterNumbered
 *   spec-paragraph    Paragraph overlay fallback clusters (spec tolerance) → rowTextFromClusterSpec
 *   notes-fast-manual Fast-manual: one double-click per LINE in the region, top-down
 *   notes-manual      Notes Manual → joinNotesManualCells (+ the boundaries NotesParser saves)
 *   spec-auto         /api/spec-parse → bindSpecSectionsInRegion (with and without sub-sections)
 */
import type { BboxLTWH, TextractLine, TextractPageData } from "@/types";
import type { ColumnShape } from "@/lib/classifier-engine/shape-column";
import { mergeGrids, type MergedGrid, type MethodResult } from "@/lib/grid-merger";
import { detectRowsAndColumns, extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import { methodOcrPositions, methodTextractTables } from "@/lib/services/table-parse";
import { methodShapeRows } from "@/lib/services/table-rows-shapes";
import { CLUSTER_Y_TOLERANCE_FACTOR } from "@/lib/spatial-constants";
import {
  bindSpecSectionsInRegion,
  clusterLinesByYGap,
  clusterUnionBbox,
  linesInside,
  parseNotesFromRegion,
  rowTextFromClusterNumbered,
  rowTextFromClusterSpec,
} from "@/lib/specnote-parser";
import { joinKeynoteIntersections } from "./keynote-manual";
import { joinManualCells } from "./manual-cells";
import { fastManualGrid, nextFastManualColumns } from "./notes-fast-manual";
import { joinNotesManualCells } from "./notes-manual";

type MinMax = [number, number, number, number];

/** The slice a path needs: the `bp-parse-fixture/1` fields (see scripts/parse-engine-fixtures/synthesize.ts). */
export interface LegacySlice {
  id: string;
  page: TextractPageData;
  shapes: ColumnShape[];
  region: MinMax;
  manual: { columnBBs: MinMax[]; rowBBs: MinMax[]; columnNames: string[] };
  guided: { rows: number[]; cols: number[] };
}

export const LEGACY_PATH_IDS = [
  "ocr-positions",
  "textract",
  "shape-rows",
  "merger",
  "guided-extract",
  "manual",
  "keynote-manual",
  "keynote-guided",
  "notes-auto",
  "notes-guided",
  "notes-paragraph",
  "spec-paragraph",
  "notes-fast-manual",
  "notes-manual",
  "spec-auto",
] as const;
export type LegacyPathId = (typeof LEGACY_PATH_IDS)[number];

/** A MethodResult without its `debug` block (timings and intermediates are not behaviour). */
function strip(r: MethodResult): Omit<MethodResult, "debug"> {
  const { debug: _debug, ...rest } = r;
  void _debug;
  return rest;
}

const toLtwh = ([x0, y0, x1, y1]: MinMax): BboxLTWH => [x0, y0, x1 - x0, y1 - y0];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Fast-manual: the user double-clicks the centre of every LINE in the region, top to bottom. */
function fastManualReplay(lines: readonly TextractLine[], region: MinMax): unknown {
  const [x0, y0, x1, y1] = region;
  const linesInRegion = lines.filter((line) => {
    if (!line.bbox || line.bbox.length < 4) return false;
    const cx = line.bbox[0] + line.bbox[2] / 2;
    const cy = line.bbox[1] + line.bbox[3] / 2;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  });
  const clicks = [...linesInRegion].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  let columns: number[] = [];
  let selected: TextractLine[] = [];
  let grid: unknown = null;
  for (const target of clicks) {
    const nx = target.bbox[0] + target.bbox[2] / 2;
    const ny = target.bbox[1] + target.bbox[3] / 2;
    const hit = linesInRegion.find((line) => {
      const [bx, by, bw, bh] = line.bbox;
      return nx >= bx && nx <= bx + bw && ny >= by && ny <= by + bh;
    });
    if (!hit) continue;
    if (selected.some((l) => l === hit || (l.text === hit.text && l.bbox[1] === hit.bbox[1]))) continue;
    columns = nextFastManualColumns(columns, hit, 1000);
    selected = [...selected, hit].sort((a, b) => a.bbox[1] - b.bbox[1]);
    grid = fastManualGrid(selected, columns);
  }
  return grid;
}

function paragraphs(slice: LegacySlice, spec: boolean): unknown {
  const tol = spec ? CLUSTER_Y_TOLERANCE_FACTOR * 0.035 * 8 : CLUSTER_Y_TOLERANCE_FACTOR * 0.025 * 4;
  const clusters = clusterLinesByYGap(linesInside(toLtwh(slice.region), slice.page.lines), tol);
  return clusters.map((cluster) => ({
    bbox: clusterUnionBbox(cluster),
    rowText: spec ? rowTextFromClusterSpec(cluster) : rowTextFromClusterNumbered(cluster),
  }));
}

/** Run one legacy path on a slice. Never throws for a well-formed slice; a path that does not apply returns null. */
export function runLegacyPath(id: LegacyPathId, s: LegacySlice): unknown {
  const words = s.page.words;
  switch (id) {
    case "ocr-positions":
      return strip(methodOcrPositions(words, s.region));
    case "textract":
      return strip(methodTextractTables(s.page.tables, s.region));
    case "shape-rows":
      return strip(methodShapeRows(words, s.shapes, s.region));
    case "merger": {
      const merged: MergedGrid = mergeGrids([
        methodOcrPositions(words, s.region),
        methodTextractTables(s.page.tables, s.region),
        methodShapeRows(words, s.shapes, s.region),
      ].map((r) => clone(r)));
      return merged;
    }
    case "guided-extract": {
      const proposal = detectRowsAndColumns(words, s.region);
      return {
        proposal: { rows: proposal.rowBoundaries, cols: proposal.colBoundaries, confidence: proposal.confidence },
        onProposal: extractCellsFromGrid(words, proposal.rowBoundaries, proposal.colBoundaries),
        onLines: extractCellsFromGrid(words, s.guided.rows, s.guided.cols),
      };
    }
    case "manual":
      if (s.manual.columnBBs.length === 0 || s.manual.rowBBs.length === 0) return null;
      return joinManualCells(words, s.manual.columnBBs, s.manual.rowBBs, s.manual.columnNames);
    case "keynote-manual":
      if (s.manual.columnBBs.length < 2 || s.manual.rowBBs.length === 0) return null;
      return joinKeynoteIntersections(words, s.manual.columnBBs, s.manual.rowBBs);
    case "keynote-guided": {
      if (s.guided.rows.length < 2 || s.guided.cols.length < 2) return null;
      const result = extractCellsFromGrid(words, s.guided.rows, s.guided.cols);
      if (result.rows.length === 0) return null;
      return {
        headers: result.headers,
        rows: result.rows,
        tagColumn: result.headers[0],
        rowCount: result.rows.length,
        columnCount: result.headers.length,
      };
    }
    case "notes-auto":
      return parseNotesFromRegion(s.page, toLtwh(s.region), { autoSplitColumns: true }) ?? null;
    case "notes-guided": {
      const grid = parseNotesFromRegion(s.page, toLtwh(s.region), { autoSplitColumns: true });
      const rows = grid?.rowBoundaries ?? [];
      const cols = grid?.colBoundaries ?? [];
      if (rows.length < 2 || cols.length < 2) return { proposal: { rows, cols }, grid: null };
      const { headers, rows: dataRows } = extractCellsFromGrid(words, rows, cols);
      return { proposal: { rows, cols }, grid: { headers, rows: dataRows } };
    }
    case "notes-paragraph":
      return paragraphs(s, false);
    case "spec-paragraph":
      return paragraphs(s, true);
    case "notes-fast-manual":
      return fastManualReplay(s.page.lines, s.region);
    case "notes-manual": {
      const columns = s.manual.columnBBs;
      const rowBbs = s.manual.rowBBs;
      if (columns.length < 2 || rowBbs.length < 1) return null;
      const joined = joinNotesManualCells(words, columns, rowBbs);
      if (!joined) return null;
      const xs = [...columns.map((c) => c[0]), columns[columns.length - 1][2]];
      const ys = [...rowBbs.map((r) => r[1]), rowBbs[rowBbs.length - 1][3]];
      return { headers: joined.headers, rows: joined.rows, colBoundaries: xs, rowBoundaries: ys };
    }
    case "spec-auto":
      return {
        plain: bindSpecSectionsInRegion(s.page.lines, toLtwh(s.region), { includeSubSections: false }) ?? null,
        withSubSections: bindSpecSectionsInRegion(s.page.lines, toLtwh(s.region), { includeSubSections: true }) ?? null,
      };
  }
}

/** Every path on one slice, keyed by path id; JSON-normalized (undefined keys dropped) like a stored golden. */
export function runLegacyPaths(s: LegacySlice): Record<LegacyPathId, unknown> {
  const out = {} as Record<LegacyPathId, unknown>;
  for (const id of LEGACY_PATH_IDS) out[id] = JSON.parse(JSON.stringify(runLegacyPath(id, s) ?? null));
  return out;
}
