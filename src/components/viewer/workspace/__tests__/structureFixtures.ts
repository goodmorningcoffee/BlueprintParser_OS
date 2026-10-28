// [TP-3 WP-3.N] Synthetic parse results for the Structure step tests (PLAN §1.6 rule 12: pseudo-text only, no real
// drawing text). The words sit inside their cells / paragraph lines, so WP-3.D's real `applyOps` re-assembles the
// grid and re-reads the paragraph lines from them exactly as the commit does on the server.
import type {
  BboxMinMax,
  ParseAlternative,
  ParseResult,
  StructureCell,
  StructureModel,
  StructureParagraphDoc,
  StructureRow,
  StructureTableModel,
} from "@/lib/parse-engine/types";

type Word = { t: string; b: BboxMinMax };

/** One word per cell text token, centred vertically in [y0, y1], starting at x0 + 0.005. */
function wordsAt(text: string, x0: number, y0: number, y1: number, step = 0.03): Word[] {
  const yc = (y0 + y1) / 2;
  return text.split(" ").filter(Boolean).map((t, i) => ({ t, b: [x0 + 0.005 + i * step, yc - 0.006, x0 + 0.005 + i * step + step * 0.8, yc + 0.006] as BboxMinMax }));
}

export const stamp = (budget: ParseResult["stamp"]["budget"] = "instant", evidenceHash = "ev-n"): ParseResult["stamp"] => ({
  engine: "pe/1.0.0", caps: {}, methods: [], budget, evidenceHash, paramsHash: "p", at: "2026-10-28T00:00:00Z",
});

/** A table result: `colX` = column boundaries, `rowY` = row boundaries, `grid[r][c]` = cell text (row 0 = header). */
export function tableResult(opts: {
  kind?: StructureTableModel["kind"];
  colX: number[];
  rowY: number[];
  grid: string[][];
  headerRows?: number;
  keys?: (StructureRow["key"] | undefined)[];
  tag?: StructureTableModel["tag"];
  alternatives?: ParseAlternative[];
  lowConf?: [number, number][];
}): ParseResult {
  const { colX, rowY, grid } = opts;
  const headerRows = opts.headerRows ?? 1;
  const bbox: BboxMinMax = [colX[0], rowY[0], colX[colX.length - 1], rowY[rowY.length - 1]];
  const cols = colX.slice(0, -1).map((x0, i) => ({ id: `c${i + 1}`, x0, x1: colX[i + 1], label: headerRows ? grid[0][i] : "", labelRaw: headerRows ? grid[0][i] : "" }));
  const rows: StructureRow[] = rowY.slice(0, -1).map((y0, i) => {
    const row: StructureRow = { id: `r${i + 1}`, y0, y1: rowY[i + 1], role: i < headerRows ? "header" : "body" };
    const key = opts.keys?.[i];
    if (key) row.key = key;
    return row;
  });
  const cells: StructureCell[] = [];
  const words: Word[] = [];
  grid.forEach((line, r) => line.forEach((text, c) => {
    if (!text) return;
    const low = opts.lowConf?.some(([a, b]) => a === r && b === c);
    cells.push({ row: rows[r].id, col: cols[c].id, text, src: "ocr-lines", conf: low ? 0.3 : 0.9 });
    words.push(...wordsAt(text, colX[c], rowY[r], rowY[r + 1], Math.min(0.03, (colX[c + 1] - colX[c]) / 3)));
  }));
  const model: StructureTableModel = {
    v: 1, kind: opts.kind ?? "schedule", bbox, headerRows, rows, cols, cells,
    ...(opts.tag ? { tag: opts.tag } : {}),
    sources: { rows: ["ocr-lines"], cols: ["x-starts"] }, quality: { conf: 0.9, agreement: 0.9, flags: [] },
  };
  return { model, alternatives: opts.alternatives ?? [], words, evidence: { words: words.length, lines: grid.length, paidCropAvailable: false }, stamp: stamp() };
}

/** The 3-column schedule: header + three body rows, keyed A1–A3, with two alternatives that disagree with fusion. */
export function scheduleResult(): ParseResult {
  return tableResult({
    colX: [0.1, 0.2, 0.35, 0.5],
    rowY: [0.1, 0.14, 0.18, 0.22, 0.26],
    grid: [["MARK", "SIZE", "COUNT"], ["A1", "W1", "2"], ["A2", "W2", "3"], ["A3", "W3", "4"]],
    keys: [undefined, { kind: "text", text: "A1" }, { kind: "text", text: "A2" }, { kind: "text", text: "A3" }],
    tag: { col: "c1", src: "header", scope: "project" },
    lowConf: [[3, 2]],
    alternatives: [
      { method: "shape-centres", rows: 3, cols: 0, agreement: 0.7, conf: 0.8, geometry: { rowLines: [0.1, 0.14, 0.2, 0.26], colLines: [] } },
      { method: "textract-cells", rows: 4, cols: 4, agreement: 0.95, conf: 0.9, geometry: { rowLines: [0.1, 0.14, 0.18, 0.22, 0.26], colLines: [0.1, 0.2, 0.3, 0.4, 0.5] } },
    ],
  });
}

/** A 20-column schedule (the "Wide view" case). */
export function wideResult(): ParseResult {
  const n = 20;
  const colX = Array.from({ length: n + 1 }, (_, i) => Math.round((0.05 + i * 0.045) * 1e4) / 1e4);
  const header = Array.from({ length: n }, (_, i) => `H${i + 1}`);
  const body = (r: number) => Array.from({ length: n }, (_, i) => `V${r}${i + 1}`);
  return tableResult({ colX, rowY: [0.1, 0.13, 0.16, 0.19], grid: [header, body(1), body(2)] });
}

/** A keynote list keyed by shapes; the second shape's text could not be read (the red "?" key). */
export function keynoteResult(): ParseResult {
  const shape = (y: number): BboxMinMax => [0.105, y + 0.005, 0.125, y + 0.025];
  return tableResult({
    kind: "keynote",
    colX: [0.1, 0.15, 0.45],
    rowY: [0.3, 0.33, 0.36, 0.39],
    headerRows: 0,
    grid: [["", "Synthetic note alpha"], ["", "Synthetic note beta"], ["", "Synthetic note gamma"]],
    keys: [
      { kind: "shape-text", text: "1", shapeClass: "circle", shapeBbox: shape(0.3), textSource: "inside" },
      { kind: "shape-text", text: null, shapeClass: "circle", shapeBbox: shape(0.33), textSource: "inside" },
      { kind: "shape-text", text: "3", shapeClass: "circle", shapeBbox: shape(0.36), textSource: "inside" },
    ],
    tag: { col: "c1", src: "shape", shapeClass: "circle", scope: "sheet" },
  });
}

/** A notes block: ¶1 has two visual lines, ¶2 and ¶3 one each, under one block header. */
export function notesResult(): ParseResult {
  const lineWords = (text: string, y0: number) => wordsAt(text, 0.1, y0, y0 + 0.02, 0.05);
  const words = [
    ...lineWords("SYNTHETIC NOTES", 0.51),
    ...lineWords("1 Synthetic alpha", 0.55),
    ...lineWords("beta gamma", 0.58),
    ...lineWords("2 Synthetic delta", 0.61),
    ...lineWords("3 Synthetic epsilon", 0.64),
  ];
  const para = (id: string, key: string, text: string, b: BboxMinMax, lineCount: number) => ({
    id, blockId: "b1", key, keyPath: [key], keyNorm: key, depth: 0, text, b, lineCount,
  });
  const model: StructureParagraphDoc = {
    v: 1, kind: "notes", bbox: [0.1, 0.5, 0.4, 0.67],
    blocks: [{ id: "b1", header: "SYNTHETIC NOTES", headerNorm: "SYNTHETIC NOTES", b: [0.1, 0.51, 0.4, 0.53] }],
    paragraphs: [
      para("p1", "1", "Synthetic alpha beta gamma", [0.1, 0.55, 0.4, 0.6], 2),
      para("p2", "2", "Synthetic delta", [0.1, 0.61, 0.4, 0.63], 1),
      para("p3", "3", "Synthetic epsilon", [0.1, 0.64, 0.4, 0.66], 1),
    ],
    sources: { segment: ["hanging-indent"] }, quality: { conf: 0.9, agreement: 0.9, flags: [] },
  };
  return { model, alternatives: [], words, evidence: { words: words.length, lines: 5, paidCropAvailable: false }, stamp: stamp() };
}

export const isTable = (m: StructureModel): m is StructureTableModel => !("paragraphs" in m);
