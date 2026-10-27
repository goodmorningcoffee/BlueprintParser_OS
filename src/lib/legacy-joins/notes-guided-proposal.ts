// [table-pipeline WP-2.B] Notes › Guided proposal (POST /api/notes-parse/propose), shared by the
// route service (`server/services/notes-parse.ts`) and the legacy-golden adapter (`./legacy-paths.ts`).
//
// The notes binders return one row boundary per note: the TOP of each note, with no bottom. Guided
// extraction (`extractCellsFromGrid`) makes N-1 rows from N boundaries, so the last note was never
// extracted (C04-03, K07). The proposal now closes the grid at the region's bottom edge, so N notes
// give N rows. Columns are unchanged (the binders already return both outer edges). Pure.

type MinMax = readonly [number, number, number, number];

export interface NotesGuidedProposal {
  proposedRows: number[];
  proposedCols: number[];
}

/** The notes grid's boundaries as a guided proposal; rows closed at the region bottom. */
export function notesGuidedProposal(
  grid: { rowBoundaries?: readonly number[]; colBoundaries?: readonly number[] } | null | undefined,
  regionBbox: MinMax,
): NotesGuidedProposal {
  if (!grid) return { proposedRows: [], proposedCols: [] };
  const rows = [...(grid.rowBoundaries ?? [])];
  const bottom = regionBbox[3];
  if (rows.length > 0 && Number.isFinite(bottom) && rows[rows.length - 1] < bottom) rows.push(bottom);
  return { proposedRows: rows, proposedCols: [...(grid.colBoundaries ?? [])] };
}
