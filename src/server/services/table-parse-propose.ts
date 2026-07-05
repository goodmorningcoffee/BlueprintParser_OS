// [refactor jul5 S026] /api/table-parse/propose route contract, folded from the legacy fat
// route (git show bd9d51c^:src/app/api/table-parse/propose/route.ts). ENGINE BYTE-UNTOUCHED:
// detectRowsAndColumns (@/lib/ocr-grid-detect — never-throws, returns a degraded proposal on
// <4 words). Kept SEPARATE from the future services/table-parse.ts (different engine, zero
// shared logic). Char file: __tests__/parse-region.route.test.ts. Frozen:
//   • SHORT bbox message "Invalid regionBbox" (copy-paste drift vs its 4 siblings — PQ-2).
//   • NO allowDemo (demo+anon → 401, unlike the notes/spec routes) and NO demo feature gate
//     (PQ-3). Do NOT add either.
//   • Engine gets textractData.WORDS + the MinMax regionBbox UNCONVERTED (no LTWH — unlike
//     notes/spec) + layoutHint + gridOptions passed through raw (PQ-4).
//   • ALWAYS the 8-key response {proposedRows,proposedCols,rowCenters,colCenters,rowCount,
//     colCount,wordCount,confidence} — no early return even degraded (PQ-6).

import { detectRowsAndColumns, type GridDetectOptions } from "@/lib/ocr-grid-detect";
import { resolveRegionPage } from "./region-parse-shared";

export async function tableParsePropose(rawBody: Record<string, unknown>) {
  const { textractData, regionBbox } = await resolveRegionPage(rawBody, {
    bboxMessage: "Invalid regionBbox",
    allowDemo: false,
  });
  const { layoutHint, gridOptions } = rawBody as {
    layoutHint?: { columns?: number; tagColumnPosition?: "left" | "right" };
    gridOptions?: GridDetectOptions;
  };

  const proposal = detectRowsAndColumns(
    textractData.words,
    regionBbox,
    layoutHint,
    gridOptions,
  );

  return {
    proposedRows: proposal.rowBoundaries,
    proposedCols: proposal.colBoundaries,
    rowCenters: proposal.rows.map((r) => r.yCenter),
    colCenters: proposal.cols.map((c) => c.center),
    rowCount: proposal.rows.length,
    colCount: proposal.cols.length,
    wordCount: proposal.wordCount,
    confidence: proposal.confidence,
  };
}
