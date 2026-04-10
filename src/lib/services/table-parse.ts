/**
 * Table parsing methods — OCR positions, Textract tables, OpenCV lines.
 *
 * These are the first 3 of the 7-method merge pipeline. Methods 4-7
 * (img2table, camelot lattice, camelot stream, pdfplumber) are in
 * their own modules: img2table-extract.ts and camelot-extract.ts.
 *
 * Extracted from api/table-parse/route.ts to keep the route handler thin.
 */
import { rasterizePage } from "@/lib/pdf-rasterize";
import { detectTableLines } from "@/lib/table-lines";
import type { MethodResult } from "@/lib/grid-merger";
import type { TextractWord, TextractTable } from "@/types";
import { logger } from "@/lib/logger";

// ─── Method 1: OCR Word Positions ─────────────────────────

const DEFAULT_ROW_Y_TOL = 0.006;
const DEFAULT_MIN_COL_GAP = 0.015;
const HEADER_KW = new Set([
  "NO", "NO.", "NUMBER", "TAG", "MARK", "TYPE", "SIZE", "WIDTH", "HEIGHT",
  "MATERIAL", "FINISH", "HARDWARE", "REMARKS", "DESCRIPTION", "LOCATION",
  "QTY", "QUANTITY", "RATING", "FRAME", "GLAZING", "NOTES", "ROOM",
  "FLOOR", "CEILING", "WALL", "BASE", "MANUFACTURER", "MODEL", "COLOR",
]);
const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;

export interface OcrParseOptions {
  rowTolerance?: number;
  minColGap?: number;
  colHitRatio?: number;
  headerMode?: "auto" | "first" | "none";
}

export function methodOcrPositions(
  words: TextractWord[],
  regionBbox: [number, number, number, number],
  options?: OcrParseOptions,
): MethodResult {
  const ROW_Y_TOL = options?.rowTolerance ?? DEFAULT_ROW_Y_TOL;
  const MIN_COL_GAP = options?.minColGap ?? DEFAULT_MIN_COL_GAP;
  const colHitRatio = options?.colHitRatio ?? 0.3;
  const headerMode = options?.headerMode ?? "auto";
  const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

  // Get words inside region
  const regionWords = words.filter((w) => {
    const cx = w.bbox[0] + w.bbox[2] / 2;
    const cy = w.bbox[1] + w.bbox[3] / 2;
    return cx >= rMinX && cx <= rMaxX && cy >= rMinY && cy <= rMaxY;
  });

  if (regionWords.length < 6) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0 };
  }

  // Cluster rows by Y
  const sorted = [...regionWords].sort((a, b) => (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2));
  const rowClusters: { words: TextractWord[] }[] = [];
  let curCluster: TextractWord[] = [sorted[0]];
  let curY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;

  for (let i = 1; i < sorted.length; i++) {
    const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
    if (Math.abs(wy - curY) <= ROW_Y_TOL) {
      curCluster.push(sorted[i]);
    } else {
      rowClusters.push({ words: curCluster.sort((a, b) => a.bbox[0] - b.bbox[0]) });
      curCluster = [sorted[i]];
      curY = wy;
    }
  }
  if (curCluster.length > 0) {
    rowClusters.push({ words: curCluster.sort((a, b) => a.bbox[0] - b.bbox[0]) });
  }

  if (rowClusters.length < 3) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0 };
  }

  // Detect columns from X-clusters
  const allLefts = regionWords.map((w) => w.bbox[0]).sort((a, b) => a - b);
  const clusters: number[][] = [[allLefts[0]]];
  for (let i = 1; i < allLefts.length; i++) {
    if (allLefts[i] - allLefts[i - 1] > MIN_COL_GAP) clusters.push([allLefts[i]]);
    else clusters[clusters.length - 1].push(allLefts[i]);
  }

  const minHits = Math.max(2, Math.floor(rowClusters.length * colHitRatio));
  let stableClusters = clusters.filter((c) => c.length >= minHits);
  if (stableClusters.length < 2) stableClusters = clusters.length >= 2 ? clusters : [];
  if (stableClusters.length < 2) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0.1 };
  }

  const colCenters = stableClusters.map((c) => c.reduce((s, x) => s + x, 0) / c.length).sort((a, b) => a - b);
  const maxRight = Math.max(...regionWords.map((w) => w.bbox[0] + w.bbox[2]));
  const colBounds = colCenters.map((center, i) => ({
    left: Math.max(0, i === 0 ? rMinX - 0.005 : (colCenters[i - 1] + center) / 2),
    right: Math.min(1, i === colCenters.length - 1 ? maxRight + 0.005 : (center + colCenters[i + 1]) / 2),
    center,
  }));

  // Extract cell grid
  const grid = rowClusters.map((row) => {
    const cells = new Array(colBounds.length).fill("");
    for (const w of row.words) {
      const wx = w.bbox[0] + w.bbox[2] / 2;
      let colIdx = colBounds.findIndex((c) => wx >= c.left && wx < c.right);
      if (colIdx === -1) {
        let minDist = Infinity;
        colBounds.forEach((c, ci) => { const d = Math.abs(wx - c.center); if (d < minDist) { minDist = d; colIdx = ci; } });
      }
      if (colIdx >= 0) cells[colIdx] = cells[colIdx] ? cells[colIdx] + " " + w.text : w.text;
    }
    return cells;
  });

  // Header detection: respect headerMode override
  let headerIdx = -1;
  if (headerMode === "first") {
    headerIdx = 0;
  } else if (headerMode === "none") {
    headerIdx = -1;
  } else {
    let bestScore = 0;
    for (let r = 0; r < Math.min(3, grid.length); r++) {
      const score = grid[r].filter((c: string) => HEADER_KW.has(c.toUpperCase().trim())).length;
      if (score > bestScore) { bestScore = score; headerIdx = r; }
    }
    if (bestScore === 0) headerIdx = -1;
  }

  const headers = headerIdx >= 0
    ? grid[headerIdx].map((c: string, i: number) => c.trim() || `Column ${i + 1}`)
    : colBounds.map((_, i) => `Column ${i + 1}`);
  const dataRows: Record<string, string>[] = [];
  for (let r = 0; r < grid.length; r++) {
    if (r === headerIdx) continue;
    const row: Record<string, string> = {};
    let hasContent = false;
    for (let c = 0; c < headers.length; c++) {
      const val = (grid[r][c] || "").trim();
      row[headers[c]] = val;
      if (val) hasContent = true;
    }
    if (hasContent) dataRows.push(row);
  }

  if (dataRows.length < 2) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0.1 };
  }

  // Tag column
  let tagColumn: string | undefined;
  const tagHeaders = ["TAG", "MARK", "NO", "NO.", "NUMBER", "NUM", "ITEM"];
  for (const h of headers) {
    if (tagHeaders.some((kw) => h.toUpperCase().trim() === kw)) { tagColumn = h; break; }
  }
  if (!tagColumn) {
    let bestRatio = 0;
    for (const h of headers) {
      let tags = 0, nonEmpty = 0;
      for (const row of dataRows) {
        const v = (row[h] || "").trim();
        if (v) { nonEmpty++; if (RE_TAG.test(v)) tags++; }
      }
      const ratio = nonEmpty > 0 ? tags / nonEmpty : 0;
      if (ratio > bestRatio && ratio >= 0.5) { bestRatio = ratio; tagColumn = h; }
    }
  }

  // Confidence — normalized scale: content(0-0.4) + structure(0-0.3) + features(0-0.2)
  const totalCells = dataRows.length * headers.length;
  const filledCells = dataRows.reduce((s, r) => s + Object.values(r).filter((v) => v).length, 0);
  const fillRate = totalCells > 0 ? filledCells / totalCells : 0;
  const cellCounts = dataRows.map((r) => Object.values(r).filter((v) => v).length);
  const avgCells = cellCounts.reduce((s, c) => s + c, 0) / cellCounts.length;
  const consistency = cellCounts.filter((c) => Math.abs(c - avgCells) <= 1).length / cellCounts.length;
  const headerMatches = headers.filter((h) => HEADER_KW.has(h.toUpperCase().trim())).length;
  let confidence = fillRate * 0.4 + consistency * 0.2 + Math.min(headerMatches * 0.05, 0.1) + (tagColumn ? 0.1 : 0);
  confidence = Math.min(confidence, 0.85);

  // Compute cell boundaries for grid overlay
  const colBoundaries = [colBounds[0].left, ...colBounds.map((c) => c.right)];
  const usedClusterIndices: number[] = [];
  if (headerIdx >= 0) usedClusterIndices.push(headerIdx);
  for (let r = 0; r < grid.length; r++) {
    if (r === headerIdx) continue;
    if (grid[r].some((c: string) => c.trim())) usedClusterIndices.push(r);
  }
  usedClusterIndices.sort((a, b) => a - b);

  const clusterYCenters = usedClusterIndices.map((idx) => {
    const ws = rowClusters[idx].words;
    return ws.reduce((s, w) => s + w.bbox[1] + w.bbox[3] / 2, 0) / ws.length;
  });

  const rowBoundaries: number[] = [rMinY];
  for (let i = 1; i < clusterYCenters.length; i++) {
    rowBoundaries.push((clusterYCenters[i - 1] + clusterYCenters[i]) / 2);
  }
  rowBoundaries.push(rMaxY);

  return { method: "ocr-positions", headers, rows: dataRows, confidence, tagColumn, colBoundaries, rowBoundaries };
}

// ─── Method 2: Textract TABLES ────────────────────────────

export function methodTextractTables(
  tables: TextractTable[] | undefined,
  regionBbox: [number, number, number, number],
): MethodResult {
  if (!tables || tables.length === 0) {
    return { method: "textract-tables", headers: [], rows: [], confidence: 0 };
  }

  const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

  let bestTable: TextractTable | null = null;
  let bestOverlap = 0;

  for (const table of tables) {
    const [tL, tT, tW, tH] = table.bbox;
    const tMinX = tL, tMinY = tT, tMaxX = tL + tW, tMaxY = tT + tH;
    const intMinX = Math.max(rMinX, tMinX);
    const intMinY = Math.max(rMinY, tMinY);
    const intMaxX = Math.min(rMaxX, tMaxX);
    const intMaxY = Math.min(rMaxY, tMaxY);

    if (intMinX < intMaxX && intMinY < intMaxY) {
      const intArea = (intMaxX - intMinX) * (intMaxY - intMinY);
      const regionArea = (rMaxX - rMinX) * (rMaxY - rMinY);
      const overlap = regionArea > 0 ? intArea / regionArea : 0;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestTable = table;
      }
    }
  }

  if (!bestTable || bestOverlap < 0.3) {
    return { method: "textract-tables", headers: [], rows: [], confidence: 0 };
  }

  const { cells: allCells, colCount } = bestTable;
  const regionCells = allCells.filter((cell) => {
    const cy = cell.bbox[1] + cell.bbox[3] / 2;
    const cx = cell.bbox[0] + cell.bbox[2] / 2;
    return cy >= rMinY && cy <= rMaxY && cx >= rMinX && cx <= rMaxX;
  });

  const uniqueRows = [...new Set(regionCells.map((c) => c.row))].sort((a, b) => a - b);
  const rowMap = new Map(uniqueRows.map((origRow, idx) => [origRow, idx]));
  const filteredRowCount = uniqueRows.length;

  if (filteredRowCount < 1 || colCount < 1) {
    return { method: "textract-tables", headers: [], rows: [], confidence: 0 };
  }

  const grid: string[][] = Array.from({ length: filteredRowCount }, () => new Array(colCount).fill(""));
  for (const cell of regionCells) {
    const ri = rowMap.get(cell.row);
    if (ri !== undefined && cell.col >= 1 && cell.col <= colCount) {
      grid[ri][cell.col - 1] = cell.text.trim();
    }
  }

  const headers = Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
  const dataRows: Record<string, string>[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row: Record<string, string> = {};
    let hasContent = false;
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = grid[r][c] || "";
      if (grid[r][c]) hasContent = true;
    }
    if (hasContent) dataRows.push(row);
  }

  const totalCells = dataRows.length * headers.length;
  const filledCells = dataRows.reduce((s, r) => s + Object.values(r).filter((v) => v).length, 0);
  const fillRate = totalCells > 0 ? filledCells / totalCells : 0;
  const avgCellConf = regionCells.length > 0 ? regionCells.reduce((s, c) => s + c.confidence, 0) / regionCells.length / 100 : 0;
  const confidence = Math.min(fillRate * 0.4 + avgCellConf * 0.3 + bestOverlap * 0.1 + 0.1, 0.90);

  return { method: "textract-tables", headers, rows: dataRows, confidence };
}

// ─── Method 3: OpenCV Line Detection ──────────────────────

export interface OpenCvOptions {
  minHLineLengthRatio?: number;
  minVLineLengthRatio?: number;
  clusteringTolerance?: number;
}

export async function methodOpenCvLines(
  pdfBuffer: Buffer,
  pageNumber: number,
  regionBbox: [number, number, number, number],
  allWords: TextractWord[],
  options?: OpenCvOptions,
): Promise<MethodResult> {
  try {
    const pngBuffer = await rasterizePage(pdfBuffer, pageNumber, 150);
    const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

    const lineGrid = await detectTableLines(pngBuffer, {
      minHLineLengthRatio: options?.minHLineLengthRatio,
      minVLineLengthRatio: options?.minVLineLengthRatio,
      clusteringTolerance: options?.clusteringTolerance,
    });

    if (lineGrid.confidence < 0.3 || lineGrid.rowCount < 1 || lineGrid.colCount < 1) {
      return { method: "opencv-lines", headers: [], rows: [], confidence: 0 };
    }

    const rowYs = lineGrid.rows.map((r) => r.y);
    const colXs = lineGrid.cols.map((c) => c.x);
    const regionRowYs = rowYs.filter((y) => y >= rMinY && y <= rMaxY);
    const regionColXs = colXs.filter((x) => x >= rMinX && x <= rMaxX);

    if (regionRowYs.length < 2 || regionColXs.length < 2) {
      return { method: "opencv-lines", headers: [], rows: [], confidence: lineGrid.confidence * 0.3 };
    }

    const numRows = regionRowYs.length - 1;
    const numCols = regionColXs.length - 1;
    const grid: string[][] = [];

    for (let ri = 0; ri < numRows; ri++) {
      const cellTop = regionRowYs[ri];
      const cellBottom = regionRowYs[ri + 1];
      const rowCells: string[] = [];

      for (let ci = 0; ci < numCols; ci++) {
        const cellLeft = regionColXs[ci];
        const cellRight = regionColXs[ci + 1];
        const cellWords = allWords.filter((w) => {
          const cx = w.bbox[0] + w.bbox[2] / 2;
          const cy = w.bbox[1] + w.bbox[3] / 2;
          return cx >= cellLeft && cx <= cellRight && cy >= cellTop && cy <= cellBottom;
        });
        rowCells.push(cellWords.sort((a, b) => a.bbox[0] - b.bbox[0]).map((w) => w.text).join(" "));
      }
      grid.push(rowCells);
    }

    const headers = Array.from({ length: numCols }, (_, i) => `Column ${i + 1}`);
    const dataRows: Record<string, string>[] = [];
    for (let r = 0; r < grid.length; r++) {
      const row: Record<string, string> = {};
      let hasContent = false;
      for (let c = 0; c < headers.length; c++) {
        row[headers[c]] = (grid[r][c] || "").trim();
        if (grid[r][c]) hasContent = true;
      }
      if (hasContent) dataRows.push(row);
    }

    return { method: "opencv-lines", headers, rows: dataRows, confidence: lineGrid.confidence };
  } catch (err) {
    logger.error("[table-parse] OpenCV method failed:", err);
    return { method: "opencv-lines", headers: [], rows: [], confidence: 0 };
  }
}
