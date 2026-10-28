// [refactor jul5 S026] /api/spec-parse + /api/spec-parse/propose route contracts, folded
// from the legacy fat routes (git show bd9d51c^:src/app/api/spec-parse/route.ts and
// …/propose/route.ts). ENGINE BYTE-UNTOUCHED: bindSpecSectionsInRegion (@/lib/specnote-
// parser) + detectCsiCodes (@/lib/csi-detect). Char file: __tests__/parse-region.route.test.ts.
// Frozen (PQ refs = char-file header):
//   • Engine gets textractData.LINES (not the whole object) + LTWH-converted bbox +
//     {includeSubSections: !!flag} coercion (PQ-4).
//   • csiTags = detectCsiCodes(bodyText) passed through UNMAPPED — full CsiCode objects,
//     UNLIKE notes-parse's 2-key mapping (PQ-5 asymmetry, do not harmonize). bodyText =
//     sections.map(s => `${s.sectionHeader}\n${s.body}`).join("\n\n") — format pinned.
//   • CSI detect non-fatal inner try/catch kept (only the outer leaky catch-all retired).
//   • No-result shapes: auto → {sections:[],csiTags:[],note:"No spec section headers
//     detected in region"}; propose → {proposedRows:[]} (PQ-6); propose coalesces ?? [],
//     auto emits rowBoundaries possibly-undefined (dropped by JSON — PQ-7).
//   • NOTE: /api/spec-parse/propose has NO UI consumer today (SpecParser.tsx fetches only
//     /api/spec-parse) — folded byte-faithful anyway; owner disposition tracked in S026 memory.

import { bindSpecSectionsInRegion } from "@/lib/specnote-parser";
import { detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB), threaded into
// the spec-parse detect below (D-1/D-2). ENGINE still byte-untouched — only its args change.
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import type { CsiCode } from "@/types";
import { logger } from "@/lib/logger";
import { resolveRegionPage, LONG_BBOX_MESSAGE } from "./region-parse-shared";
// [table-pipeline WP-3.J] Spec Auto on the paragraph engine under tools.specAuto (default legacy; /propose stays legacy).
import { parseEngineMode, readParseEngineFlags } from "./parse-engine/flags";
import { specAutoOnEngine } from "./parse-engine/classic-paragraphs";

const OPTS = { bboxMessage: LONG_BBOX_MESSAGE, allowDemo: true };

export async function specParse(rawBody: Record<string, unknown>) {
  const { textractData, regionBbox, companyId, pageNumber } = await resolveRegionPage(rawBody, OPTS);
  // [refactor jul9 P2-A C1] resolve company CSI context for the detect below (no tx here).
  const csiCtx = await getCompanyCsiContext(companyId);
  if (parseEngineMode(await readParseEngineFlags(), "specAuto") === "engine") {
    return specAutoOnEngine({ page: pageNumber, regionBbox, textractData, csiCtx });
  }
  const { includeSubSections } = rawBody as { includeSubSections?: boolean };
  const [x0, y0, x1, y1] = regionBbox;

  const result = bindSpecSectionsInRegion(
    textractData.lines,
    [x0, y0, x1 - x0, y1 - y0],
    { includeSubSections: !!includeSubSections },
  );

  if (!result) {
    return {
      sections: [],
      csiTags: [],
      note: "No spec section headers detected in region",
    };
  }

  let csiTags: CsiCode[] = [];
  try {
    const bodyText = result.sections.map((s) => `${s.sectionHeader}\n${s.body}`).join("\n\n");
    // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2). [csi-v2 S6] pageKind spec.
    csiTags = detectCsiCodes(bodyText, { context: { pageKind: "spec" } }, csiCtx.config, csiCtx.db);
  } catch (err) {
    logger.warn("[spec-parse] CSI detect failed (non-fatal):", err);
  }

  return {
    sections: result.sections,
    rowBoundaries: result.rowBoundaries,
    csiTags,
  };
}

export async function specParsePropose(rawBody: Record<string, unknown>) {
  const { textractData, regionBbox } = await resolveRegionPage(rawBody, OPTS);
  const { includeSubSections } = rawBody as { includeSubSections?: boolean };
  const [x0, y0, x1, y1] = regionBbox;

  const result = bindSpecSectionsInRegion(
    textractData.lines,
    [x0, y0, x1 - x0, y1 - y0],
    { includeSubSections: !!includeSubSections },
  );

  if (!result) {
    return { proposedRows: [] };
  }

  return { proposedRows: result.rowBoundaries ?? [] };
}
