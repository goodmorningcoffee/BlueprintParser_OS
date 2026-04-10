/**
 * grid-merger.ts — Merge results from multiple table parsing methods.
 *
 * Takes N grids (each with confidence), picks the best as base,
 * fills empty cells from others, flags cells where methods disagree.
 *
 * Designed for extensibility — adding a 4th method (Vision LLM) later
 * just means pushing another MethodResult into the array.
 */

export interface MethodResult {
  method: string;
  headers: string[];
  rows: Record<string, string>[];
  confidence: number;
  tagColumn?: string;
  /** N+1 normalized X coords: [regionMinX, divider1, …, regionMaxX] for N columns */
  colBoundaries?: number[];
  /** M+1 normalized Y coords for M visible rows (header + data) */
  rowBoundaries?: number[];
  /** Error message if method failed */
  error?: string;
}

export interface MergedGrid {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn?: string;
  confidence: number;
  methods: { name: string; confidence: number; gridShape: [number, number]; error?: string }[];
  disagreements: { row: number; col: string; values: { method: string; value: string }[] }[];
  /** N+1 normalized X coords for column edges */
  colBoundaries?: number[];
  /** M+1 normalized Y coords for row edges (header + data rows) */
  rowBoundaries?: number[];
}

/**
 * Merge multiple parsing method results into a single best grid.
 *
 * Algorithm:
 * 1. Sort by confidence (highest first)
 * 2. Use highest-confidence grid as base
 * 3. For each cell: check agreement, fill empties, flag disagreements
 * 4. Compute final confidence boosted by agreement rate
 */
const MAX_ROWS = 10000;
const MAX_COLS = 500;

const TAG_RE = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;
const TAG_HEADERS = ["TAG", "MARK", "NO", "NO.", "NUMBER", "NUM", "ITEM", "ID", "KEY"];

/**
 * Detect the tag column in a merged grid. Unlike per-method detection,
 * this operates on the FINAL merged headers/rows so the returned name
 * is guaranteed to exist in the grid's own column keys.
 */
function findTagColumnInMergedGrid(
  headers: string[],
  rows: Record<string, string>[],
): string | undefined {
  if (headers.length === 0 || rows.length === 0) return undefined;

  // 1. Exact match on header keywords (TAG, MARK, NO., etc.)
  for (const h of headers) {
    if (TAG_HEADERS.some((kw) => h.toUpperCase().trim() === kw)) return h;
  }

  // 2. Fallback: column with >= 50% of values matching the tag regex
  let bestRatio = 0;
  let bestCol: string | undefined;
  for (const h of headers) {
    let tags = 0;
    let nonEmpty = 0;
    for (const row of rows) {
      const v = (row[h] || "").trim();
      if (v) {
        nonEmpty++;
        if (TAG_RE.test(v)) tags++;
      }
    }
    const ratio = nonEmpty > 0 ? tags / nonEmpty : 0;
    if (ratio > bestRatio && ratio >= 0.5) {
      bestRatio = ratio;
      bestCol = h;
    }
  }
  return bestCol;
}

export interface MergeOptions {
  editDistanceThreshold?: number;
}

export function mergeGrids(results: MethodResult[], options?: MergeOptions): MergedGrid {
  const editDistThreshold = options?.editDistanceThreshold ?? 2;
  // Filter out empty results and enforce size limits
  const valid = results
    .filter((r) => r.headers.length > 0 && r.rows.length > 0)
    .filter((r) => r.headers.length <= MAX_COLS && r.rows.length <= MAX_ROWS);

  if (valid.length === 0) {
    return {
      headers: [],
      rows: [],
      confidence: 0,
      methods: results.map((r) => ({
        name: r.method,
        confidence: r.confidence,
        gridShape: [r.rows.length, r.headers.length] as [number, number],
        ...(r.error ? { error: r.error } : {}),
      })),
      disagreements: [],
    };
  }

  // Penalize single-column results — almost always a parsing failure
  // (merged columns, bad line detection, or text wrapping into one blob)
  for (const r of valid) {
    if (r.headers.length <= 1) {
      r.confidence *= 0.3;
    }
  }

  // Sort by confidence descending
  const sorted = [...valid].sort((a, b) => b.confidence - a.confidence);
  const base = sorted[0];
  const others = sorted.slice(1);

  // ── Fix 1: Grid shape guard ────────────────────────────────
  // Only merge cells from methods with compatible grid shapes.
  // Methods with wildly different column/row counts get excluded from
  // cell-level merging to prevent garbled data from mismatched grids.
  const compatible = others.filter((other) => {
    if (base.headers.length === 0) return false;
    const colRatio = other.headers.length / base.headers.length;
    const rowRatio = other.rows.length / Math.max(base.rows.length, 1);
    return colRatio >= 0.5 && colRatio <= 2.0 && rowRatio >= 0.5 && rowRatio <= 1.5;
  });

  // ── Fix 2: Row alignment check ────────────────────────────
  // Verify that compatible methods' rows actually correspond by content.
  // If a method split wrapped rows differently, row indices won't match.
  const aligned = compatible.filter((other) => {
    if (base.rows.length === 0 || other.rows.length === 0) return false;
    // Check first row and a mid-point row for content similarity
    const checkRows = [0, Math.floor(Math.min(base.rows.length, other.rows.length) / 2)];
    let totalSim = 0;
    for (const ri of checkRows) {
      if (ri >= base.rows.length || ri >= other.rows.length) continue;
      totalSim += rowSimilarity(base.rows[ri], other.rows[ri], base.headers, other.headers, editDistThreshold);
    }
    return totalSim / checkRows.length >= 0.25; // at least 25% of sampled cells match
  });

  // Start with the base grid
  const headers = [...base.headers];
  const rows: Record<string, string>[] = base.rows.map((r) => ({ ...r }));
  const disagreements: MergedGrid["disagreements"] = [];

  let agreementCount = 0;
  let totalCells = 0;

  // For each cell in the base grid, check agreement with aligned methods only
  for (let ri = 0; ri < rows.length; ri++) {
    for (const header of headers) {
      const baseVal = (rows[ri][header] || "").trim();
      totalCells++;

      // Collect values from aligned methods for this cell position
      const otherValues: { method: string; value: string }[] = [];
      for (const other of aligned) {
        if (ri < other.rows.length) {
          // Try to match by header name first, then by column index
          let otherVal = "";
          if (other.rows[ri][header] !== undefined) {
            otherVal = (other.rows[ri][header] || "").trim();
          } else {
            // Column name mismatch — try by index
            const colIdx = headers.indexOf(header);
            if (colIdx < other.headers.length) {
              const otherHeader = other.headers[colIdx];
              otherVal = (other.rows[ri][otherHeader] || "").trim();
            }
          }
          if (otherVal) otherValues.push({ method: other.method, value: otherVal });
        }
      }

      if (baseVal === "") {
        // Fill empty cells from the first non-empty aligned method
        const fill = otherValues.find((v) => v.value !== "");
        if (fill) {
          rows[ri][header] = fill.value;
        }
      } else if (otherValues.length > 0) {
        // Check agreement
        const agrees = otherValues.every(
          (v) => v.value === baseVal || editDistance(v.value, baseVal) <= editDistThreshold
        );
        if (agrees) {
          agreementCount++;
        } else {
          disagreements.push({
            row: ri,
            col: header,
            values: [
              { method: base.method, value: baseVal },
              ...otherValues,
            ],
          });
        }
      } else {
        // Only base has a value — count as partial agreement (Fix 4)
        agreementCount += 0.5;
      }
    }
  }

  // Compute final confidence (Fix 5: scaled method bonus)
  const agreementRate = totalCells > 0 ? agreementCount / totalCells : 0;
  const methodBonus = Math.min(valid.length * 0.02, 0.15);
  const confidence = Math.min(
    base.confidence * 0.6 + agreementRate * 0.3 + methodBonus,
    0.98
  );

  // Re-detect tag column on the final MERGED grid. Previously this picked
  // tagColumn from whichever method found one, but that name often didn't
  // exist in the base method's column keys → Map Tags showed "0 unique tags".
  const tagColumn = findTagColumnInMergedGrid(headers, rows);

  // Pick boundaries: prefer base, else first method that has them
  const colBoundaries = base.colBoundaries || sorted.find((r) => r.colBoundaries)?.colBoundaries;
  const rowBoundaries = base.rowBoundaries || sorted.find((r) => r.rowBoundaries)?.rowBoundaries;

  return {
    headers,
    rows,
    tagColumn,
    confidence,
    methods: results.map((r) => ({
      name: r.method,
      confidence: r.confidence,
      gridShape: [r.rows.length, r.headers.length] as [number, number],
      ...(r.error ? { error: r.error } : {}),
    })),
    disagreements,
    colBoundaries,
    rowBoundaries,
  };
}

/** Check if two rows from different methods contain similar content. */
function rowSimilarity(
  rowA: Record<string, string>,
  rowB: Record<string, string>,
  headersA: string[],
  headersB: string[],
  editDistThreshold: number,
): number {
  const maxCols = Math.min(headersA.length, headersB.length, 4);
  let matches = 0;
  let compared = 0;
  for (let c = 0; c < maxCols; c++) {
    const valA = (rowA[headersA[c]] || "").trim();
    const valB = (rowB[headersB[c]] || "").trim();
    if (!valA && !valB) continue;
    compared++;
    if (valA === valB || (valA && valB && editDistance(valA, valB) <= editDistThreshold)) {
      matches++;
    }
  }
  return compared > 0 ? matches / compared : 0;
}

/** Simple edit distance (Levenshtein) for comparing cell values. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use single-row optimization
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,      // insert
        prev[j] + 1,          // delete
        prev[j - 1] + cost    // replace
      );
    }
    prev = curr;
  }
  return prev[lb];
}
