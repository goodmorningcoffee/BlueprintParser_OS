// [refactor jul5 S026] /api/notes-parse + /api/notes-parse/propose route contracts, folded
// from the legacy fat routes (git show bd9d51c^:src/app/api/notes-parse/route.ts and
// …/propose/route.ts). ENGINE BYTE-UNTOUCHED: parseNotesFromRegion (@/lib/text-region-
// classifier) + detectCsiFromGrid (@/lib/csi-detect). Char file: __tests__/parse-region.
// route.test.ts. Frozen (PQ refs = char-file header):
//   • Bbox arrives MinMax from the client, engine takes LTWH — converted here (PQ-4).
//   • autoSplitColumns ?? true default (PQ-4).
//   • csiTags MAPPED to {code, description} — drops trade etc. (PQ-5; spec-parse does NOT
//     map — frozen asymmetry, do not harmonize).
//   • CSI detect wrapped in a non-fatal inner try/catch (kept; only the outer leaky
//     catch-all retired — diff B).
//   • No-grid shapes: auto → {headers:[],rows:[],csiTags:[],note:"No numbered items detected
//     in region"}; propose → {proposedRows:[],proposedCols:[]} (PQ-6). Full-grid auto emits
//     rowBoundaries/colBoundaries only when the engine provided them (undefined keys dropped
//     by the JSON layer — PQ-7); propose coalesces ?? [].

import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import { detectCsiFromGrid } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB), threaded into
// the notes-parse detect below (D-1/D-2). ENGINE still byte-untouched — only its args change.
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import type { BboxLTWH } from "@/types";
import { logger } from "@/lib/logger";
import { resolveRegionPage, LONG_BBOX_MESSAGE } from "./region-parse-shared";
import { notesGuidedProposal } from "@/lib/legacy-joins/notes-guided-proposal";
// [table-pipeline WP-3.J] Notes Auto on the paragraph engine under tools.notesAuto (default legacy; Guided stays legacy).
import { parseEngineMode, readParseEngineFlags } from "./parse-engine/flags";
import { notesAutoOnEngine } from "./parse-engine/classic-paragraphs";

const OPTS = { bboxMessage: LONG_BBOX_MESSAGE, allowDemo: true };

export async function notesParse(rawBody: Record<string, unknown>) {
  const { textractData, regionBbox, companyId, pageNumber } = await resolveRegionPage(rawBody, OPTS);
  // [refactor jul9 P2-A C1] resolve company CSI context for the detect below (no tx here).
  const csiCtx = await getCompanyCsiContext(companyId);
  if (parseEngineMode(await readParseEngineFlags(), "notesAuto") === "engine") {
    return notesAutoOnEngine({ page: pageNumber, regionBbox, textractData, csiCtx });
  }
  const { autoSplitColumns } = rawBody as { autoSplitColumns?: boolean };
  const [x0, y0, x1, y1] = regionBbox;
  const ltwhBbox: BboxLTWH = [x0, y0, x1 - x0, y1 - y0];

  const grid = parseNotesFromRegion(textractData, ltwhBbox, {
    autoSplitColumns: autoSplitColumns ?? true,
  });
  if (!grid) {
    return {
      headers: [],
      rows: [],
      csiTags: [],
      note: "No numbered items detected in region",
    };
  }

  let csiTags: { code: string; description: string }[] = [];
  try {
    // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
    const detected = detectCsiFromGrid(grid.headers, grid.rows, csiCtx.config, csiCtx.db);
    csiTags = detected.map((c) => ({ code: c.code, description: c.description }));
  } catch (err) {
    logger.warn("[notes-parse] CSI detect failed (non-fatal):", err);
  }

  return {
    headers: grid.headers,
    rows: grid.rows,
    rowBoundaries: grid.rowBoundaries,
    colBoundaries: grid.colBoundaries,
    csiTags,
  };
}

export async function notesParsePropose(rawBody: Record<string, unknown>) {
  const { textractData, regionBbox } = await resolveRegionPage(rawBody, OPTS);
  const { autoSplitColumns } = rawBody as { autoSplitColumns?: boolean };
  const [x0, y0, x1, y1] = regionBbox;
  const ltwhBbox: BboxLTWH = [x0, y0, x1 - x0, y1 - y0];

  const grid = parseNotesFromRegion(textractData, ltwhBbox, {
    autoSplitColumns: autoSplitColumns ?? true,
  });
  // [table-pipeline WP-2.B] rows closed at the region bottom, so the last note is extracted (C04-03).
  return notesGuidedProposal(grid, regionBbox);
}
