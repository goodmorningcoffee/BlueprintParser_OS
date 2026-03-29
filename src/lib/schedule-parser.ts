/**
 * schedule-parser.ts
 *
 * System 4 — ScheduleParser: Extracts structured row/column data from
 * classified table regions using OCR word positions.
 *
 * Strategy:
 *   1. Collect OCR words whose centers fall inside the classified table bbox
 *   2. Cluster words into rows by Y-coordinate proximity
 *   3. Detect column boundaries via X-coordinate frequency analysis
 *   4. Map each word to a (row, column) cell
 *   5. Identify header row (first row, often contains known keywords)
 *   6. Detect the "tag" column (short alphanumeric codes like D-01, W-03)
 *   7. Output: { headers, rows, tagColumn, rowCount, columnCount }
 *
 * Works with Textract word-level bboxes (normalized 0–1).
 * No external OCR calls — pure positional math on existing data.
 */

import type {
  TextractPageData,
  TextractWord,
  ClassifiedTable,
  ParsedRegion,
  ScheduleData,
  CsiCode,
  BboxLTWH,
  BboxMinMax,
} from "@/types";
import {
  ltwh2minmax,
  bboxCenterLTWH,
  bboxContainsPoint,
  mergeBbox,
} from "@/lib/ocr-utils";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

/** Y-distance tolerance for grouping words into the same row (normalized). */
const ROW_Y_TOLERANCE = 0.006;

/** Minimum gap between column clusters (normalized). Prevents over-splitting. */
const MIN_COL_GAP = 0.015;

/** Minimum number of rows (excluding header) for a valid schedule parse. */
const MIN_DATA_ROWS = 2;

/** Minimum number of columns for a valid schedule parse. */
const MIN_COLUMNS = 2;

/** Regex for tag-like values: short alphanumeric codes (D-01, W-03, 101A, etc.). */
const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;

/** Common header keywords that signal a schedule header row. */
const HEADER_KEYWORDS = new Set([
  "NO", "NO.", "NUMBER", "NUM", "TAG", "MARK", "TYPE", "SIZE",
  "WIDTH", "HEIGHT", "MATERIAL", "FINISH", "HARDWARE", "REMARKS",
  "DESCRIPTION", "LOCATION", "QTY", "QUANTITY", "RATING", "FRAME",
  "GLAZING", "LOUVER", "THRESHOLD", "HEAD", "JAMB", "SILL",
  "MANUFACTURER", "MODEL", "COLOR", "NOTES", "ROOM", "FLOOR",
  "CEILING", "WALL", "BASE", "WAINSCOT",
]);

// ═══════════════════════════════════════════════════════════════════
// Core: Extract words within a region bbox
// ═══════════════════════════════════════════════════════════════════

/** Get all OCR words whose center falls inside the given bbox. */
function getWordsInRegion(
  words: TextractWord[],
  regionBbox: BboxLTWH,
): TextractWord[] {
  const regionMinMax = ltwh2minmax(regionBbox);
  return words.filter((w) => {
    const center = bboxCenterLTWH(w.bbox);
    return bboxContainsPoint(regionMinMax, center);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Row Detection: Cluster words by Y-coordinate
// ═══════════════════════════════════════════════════════════════════

interface RowCluster {
  yCenter: number;       // average Y center of this row
  words: TextractWord[];
}

/** Group words into rows by clustering their Y-centers. */
function clusterRows(words: TextractWord[]): RowCluster[] {
  if (words.length === 0) return [];

  // Sort by Y center
  const sorted = [...words].sort((a, b) => {
    const ay = a.bbox[1] + a.bbox[3] / 2;
    const by = b.bbox[1] + b.bbox[3] / 2;
    return ay - by;
  });

  const rows: RowCluster[] = [];
  let currentRow: TextractWord[] = [sorted[0]];
  let currentY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;

  for (let i = 1; i < sorted.length; i++) {
    const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
    if (Math.abs(wy - currentY) <= ROW_Y_TOLERANCE) {
      currentRow.push(sorted[i]);
    } else {
      // Finalize current row
      const avgY = currentRow.reduce((s, w) => s + w.bbox[1] + w.bbox[3] / 2, 0) / currentRow.length;
      rows.push({ yCenter: avgY, words: currentRow.sort((a, b) => a.bbox[0] - b.bbox[0]) });
      currentRow = [sorted[i]];
      currentY = wy;
    }
  }

  // Finalize last row
  if (currentRow.length > 0) {
    const avgY = currentRow.reduce((s, w) => s + w.bbox[1] + w.bbox[3] / 2, 0) / currentRow.length;
    rows.push({ yCenter: avgY, words: currentRow.sort((a, b) => a.bbox[0] - b.bbox[0]) });
  }

  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// Column Detection: Find column boundaries from X-position gaps
// ═══════════════════════════════════════════════════════════════════

interface ColumnBoundary {
  left: number;   // left edge of column (normalized)
  right: number;  // right edge of column (normalized)
  center: number; // center X (for display)
}

/**
 * Detect column boundaries by analyzing the X-positions of words across rows.
 *
 * Strategy: For each row, find the left-edge X of each word. Across all rows,
 * cluster these X-positions. Gaps between clusters define column boundaries.
 */
function detectColumns(rows: RowCluster[]): ColumnBoundary[] {
  if (rows.length === 0) return [];

  // Collect all word left-edge X positions
  const allLeftEdges: number[] = [];
  for (const row of rows) {
    for (const w of row.words) {
      allLeftEdges.push(w.bbox[0]);
    }
  }
  allLeftEdges.sort((a, b) => a - b);

  if (allLeftEdges.length === 0) return [];

  // Cluster left-edges by proximity: find significant gaps
  const clusters: { positions: number[] }[] = [{ positions: [allLeftEdges[0]] }];

  for (let i = 1; i < allLeftEdges.length; i++) {
    const gap = allLeftEdges[i] - allLeftEdges[i - 1];
    if (gap > MIN_COL_GAP) {
      clusters.push({ positions: [allLeftEdges[i]] });
    } else {
      clusters[clusters.length - 1].positions.push(allLeftEdges[i]);
    }
  }

  // Filter: only keep clusters that appear in multiple rows (consistent columns)
  // A column should have entries from at least 30% of rows
  const minRowHits = Math.max(2, Math.floor(rows.length * 0.3));
  const stableClusters = clusters.filter((c) => c.positions.length >= minRowHits);

  if (stableClusters.length < MIN_COLUMNS) {
    // Fallback: use all clusters if stable filtering is too aggressive
    if (clusters.length >= MIN_COLUMNS) {
      return buildBoundaries(clusters, rows);
    }
    return [];
  }

  return buildBoundaries(stableClusters, rows);
}

/** Convert position clusters into column boundaries with left/right edges. */
function buildBoundaries(
  clusters: { positions: number[] }[],
  rows: RowCluster[],
): ColumnBoundary[] {
  // Sort clusters by average position
  const sorted = clusters
    .map((c) => {
      const avg = c.positions.reduce((s, x) => s + x, 0) / c.positions.length;
      return { avg, positions: c.positions };
    })
    .sort((a, b) => a.avg - b.avg);

  // Build boundaries: left edge = midpoint between this cluster and previous, right = midpoint to next
  const boundaries: ColumnBoundary[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const left = i === 0
      ? Math.min(...sorted[i].positions) - 0.005
      : (sorted[i - 1].avg + sorted[i].avg) / 2;

    const right = i === sorted.length - 1
      ? Math.max(...getAllRightEdges(rows)) + 0.005
      : (sorted[i].avg + sorted[i + 1].avg) / 2;

    boundaries.push({ left, right, center: sorted[i].avg });
  }

  return boundaries;
}

/** Get all right edges of words across all rows (for the last column boundary). */
function getAllRightEdges(rows: RowCluster[]): number[] {
  const edges: number[] = [];
  for (const row of rows) {
    for (const w of row.words) {
      edges.push(w.bbox[0] + w.bbox[2]);
    }
  }
  return edges.length > 0 ? edges : [1.0];
}

// ═══════════════════════════════════════════════════════════════════
// Cell Extraction: Map words to (row, column) grid
// ═══════════════════════════════════════════════════════════════════

/**
 * Assign each word to a column based on its X-center position.
 * Words within one row that fall into the same column are joined with spaces.
 */
function extractCells(
  rows: RowCluster[],
  columns: ColumnBoundary[],
): string[][] {
  return rows.map((row) => {
    const cells: string[] = new Array(columns.length).fill("");

    for (const word of row.words) {
      const wx = word.bbox[0] + word.bbox[2] / 2; // word center X
      // Find which column this word belongs to
      let colIdx = -1;
      for (let c = 0; c < columns.length; c++) {
        if (wx >= columns[c].left && wx < columns[c].right) {
          colIdx = c;
          break;
        }
      }
      // Fallback: assign to nearest column
      if (colIdx === -1) {
        let minDist = Infinity;
        for (let c = 0; c < columns.length; c++) {
          const dist = Math.abs(wx - columns[c].center);
          if (dist < minDist) {
            minDist = dist;
            colIdx = c;
          }
        }
      }
      if (colIdx >= 0) {
        cells[colIdx] = cells[colIdx]
          ? cells[colIdx] + " " + word.text
          : word.text;
      }
    }

    return cells;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Header Detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect header row. Usually the first row. Confirmed if it contains
 * known header keywords. Returns the index of the header row (usually 0).
 */
function detectHeaderRow(grid: string[][]): number {
  if (grid.length === 0) return 0;

  // Check first few rows for header keyword matches
  let bestRow = 0;
  let bestScore = 0;

  const checkRows = Math.min(3, grid.length);
  for (let r = 0; r < checkRows; r++) {
    let score = 0;
    for (const cell of grid[r]) {
      const upper = cell.toUpperCase().trim();
      if (HEADER_KEYWORDS.has(upper)) score += 2;
      // Partial match (cell contains a header keyword)
      for (const kw of HEADER_KEYWORDS) {
        if (upper.includes(kw) && upper.length < kw.length + 10) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestRow = r;
    }
  }

  return bestRow;
}

// ═══════════════════════════════════════════════════════════════════
// Tag Column Detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Identify which column contains tag/mark values (D-01, W-03, etc.).
 * Usually the first or second column. Tags are short alphanumeric codes.
 */
function detectTagColumn(
  headers: string[],
  dataRows: Record<string, string>[],
): string | undefined {
  if (headers.length === 0 || dataRows.length === 0) return undefined;

  // Strategy 1: header name contains TAG, MARK, NO, NUMBER
  const tagHeaderKeywords = ["TAG", "MARK", "NO", "NO.", "NUMBER", "NUM", "ITEM"];
  for (const header of headers) {
    const upper = header.toUpperCase().trim();
    if (tagHeaderKeywords.some((kw) => upper === kw || upper.startsWith(kw + " "))) {
      return header;
    }
  }

  // Strategy 2: check data values — column with most tag-like values
  let bestHeader: string | undefined;
  let bestTagRatio = 0;

  for (const header of headers) {
    let tagCount = 0;
    let nonEmpty = 0;
    for (const row of dataRows) {
      const val = (row[header] || "").trim();
      if (val) {
        nonEmpty++;
        if (RE_TAG.test(val)) tagCount++;
      }
    }
    const ratio = nonEmpty > 0 ? tagCount / nonEmpty : 0;
    if (ratio > bestTagRatio && ratio >= 0.5) {
      bestTagRatio = ratio;
      bestHeader = header;
    }
  }

  return bestHeader;
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse schedule-type classified tables into structured row/column data.
 *
 * @param classifiedTables - Tables classified by System 3 (table-classifier)
 * @param textractData - Full page OCR data (word-level bboxes)
 * @param pageNumber - Current page number
 * @returns ParsedRegion[] for schedule-type tables
 */
export function parseSchedules(
  classifiedTables: ClassifiedTable[],
  textractData: TextractPageData,
  pageNumber: number,
): ParsedRegion[] {
  const scheduleCats = new Set([
    "door-schedule",
    "finish-schedule",
    "material-schedule",
  ]);

  const results: ParsedRegion[] = [];

  for (const table of classifiedTables) {
    if (!scheduleCats.has(table.category)) continue;
    if (table.confidence < 0.3) continue;

    const parsed = parseOneSchedule(table, textractData.words);
    if (parsed) {
      results.push({
        id: `parsed-${table.category}-p${pageNumber}-${results.length}`,
        type: "schedule",
        category: table.category,
        bbox: table.bbox,
        confidence: Math.min(table.confidence, parsed.confidence),
        csiTags: table.csiTags,
        data: parsed.data,
      });
    }
  }

  return results;
}

/** Parse a single classified table into ScheduleData. */
function parseOneSchedule(
  table: ClassifiedTable,
  allWords: TextractWord[],
): { data: ScheduleData; confidence: number } | null {
  // 1. Get words inside region
  const regionWords = getWordsInRegion(allWords, table.bbox);
  if (regionWords.length < 6) return null; // too few words for a table

  // 2. Cluster into rows
  const rows = clusterRows(regionWords);
  if (rows.length < MIN_DATA_ROWS + 1) return null; // need header + data rows

  // 3. Detect columns
  const columns = detectColumns(rows);
  if (columns.length < MIN_COLUMNS) return null;

  // 4. Extract cell grid
  const grid = extractCells(rows, columns);

  // 5. Find header row
  const headerIdx = detectHeaderRow(grid);
  const headerCells = grid[headerIdx];

  // Build headers (use cell text or fallback to "Column N")
  const headers = headerCells.map((cell, i) =>
    cell.trim() || `Column ${i + 1}`
  );

  // 6. Build data rows (everything after header)
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

  if (dataRows.length < MIN_DATA_ROWS) return null;

  // 7. Detect tag column
  const tagColumn = detectTagColumn(headers, dataRows);

  // 8. Compute confidence based on parse quality
  let confidence = 0.5;
  // Boost: headers matched known keywords
  const headerMatches = headers.filter((h) =>
    HEADER_KEYWORDS.has(h.toUpperCase().trim())
  ).length;
  confidence += Math.min(headerMatches * 0.05, 0.2);
  // Boost: tag column found
  if (tagColumn) confidence += 0.1;
  // Boost: consistent row widths (most rows have similar non-empty cell counts)
  const cellCounts = dataRows.map((r) => Object.values(r).filter((v) => v).length);
  const avgCells = cellCounts.reduce((s, c) => s + c, 0) / cellCounts.length;
  const consistency = cellCounts.filter((c) => Math.abs(c - avgCells) <= 1).length / cellCounts.length;
  confidence += consistency * 0.15;

  confidence = Math.min(confidence, 0.95);

  return {
    data: {
      headers,
      rows: dataRows,
      tagColumn,
      rowCount: dataRows.length,
      columnCount: headers.length,
    },
    confidence,
  };
}
