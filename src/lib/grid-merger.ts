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
}

export interface MergedGrid {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn?: string;
  confidence: number;
  methods: { name: string; confidence: number; gridShape: [number, number] }[];
  disagreements: { row: number; col: string; values: { method: string; value: string }[] }[];
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

export function mergeGrids(results: MethodResult[]): MergedGrid {
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
        gridShape: [r.rows.length, r.headers.length],
      })),
      disagreements: [],
    };
  }

  // Sort by confidence descending
  const sorted = [...valid].sort((a, b) => b.confidence - a.confidence);
  const base = sorted[0];
  const others = sorted.slice(1);

  // Start with the base grid
  const headers = [...base.headers];
  const rows: Record<string, string>[] = base.rows.map((r) => ({ ...r }));
  const disagreements: MergedGrid["disagreements"] = [];

  let agreementCount = 0;
  let totalCells = 0;

  // For each cell in the base grid, check agreement with other methods
  for (let ri = 0; ri < rows.length; ri++) {
    for (const header of headers) {
      const baseVal = (rows[ri][header] || "").trim();
      totalCells++;

      // Collect values from other methods for this cell position
      const otherValues: { method: string; value: string }[] = [];
      for (const other of others) {
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
        // Fill empty cells from the first non-empty other method
        const fill = otherValues.find((v) => v.value !== "");
        if (fill) {
          rows[ri][header] = fill.value;
        }
      } else if (otherValues.length > 0) {
        // Check agreement
        const agrees = otherValues.every(
          (v) => v.value === baseVal || editDistance(v.value, baseVal) <= 2
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
        // Only base has a value — count as soft agreement
        agreementCount++;
      }
    }
  }

  // Compute final confidence
  const agreementRate = totalCells > 0 ? agreementCount / totalCells : 0;
  const methodBonus = Math.min(valid.length * 0.05, 0.15); // bonus for multiple methods succeeding
  const confidence = Math.min(
    base.confidence * 0.6 + agreementRate * 0.3 + methodBonus,
    0.98
  );

  // Pick tag column: prefer base, else first method that found one
  const tagColumn = base.tagColumn || sorted.find((r) => r.tagColumn)?.tagColumn;

  return {
    headers,
    rows,
    tagColumn,
    confidence,
    methods: results.map((r) => ({
      name: r.method,
      confidence: r.confidence,
      gridShape: [r.rows.length, r.headers.length],
    })),
    disagreements,
  };
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
