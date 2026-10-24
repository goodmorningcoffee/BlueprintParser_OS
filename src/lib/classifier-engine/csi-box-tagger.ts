/**
 * classifier-engine/csi-box-tagger.ts — the real `BoxTagger`: the CSI v2 span tagger
 * (lib/csi-page.ts `detectCsiV2`) run over ONE box's OCR words, lines rebuilt geometrically, with
 * the cap lifted to the engine maximum so a dense schedule's codes are all counted (the page-level
 * list is capped by `maxCodesPerPage` and misses codes inside tables). SERVER / CLI only: it loads
 * the KB from disk (`loadCsiKb`). When the KB is unavailable the tagger is `null` and the engine
 * falls back to the page's trigger positions inside the box.
 */

import { linesFromWordsByGeometry } from "@/lib/csi-detect";
import { loadCsiKb } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import { detectCsiV2 } from "@/lib/csi-page";
import { CSI_V2_MAX_CODES_MAX, DEFAULT_CSI_V2_CONFIG } from "@/lib/csi-v2-config";
import { logger } from "@/lib/logger";
import type { BoxTagger } from "./evidence";

let failureLogged = false;

/** A tagger over `kb` (default: the process-wide built-in KB), or null when no KB can be loaded. */
export function createCsiBoxTagger(kb?: LoadedKb): BoxTagger | null {
  let base = kb ?? null;
  if (!base) {
    try {
      base = loadCsiKb();
    } catch (err) {
      if (!failureLogged) { failureLogged = true; logger.error("[classifier-engine] CSI KB unavailable — box tagging falls back to page triggers", err); }
      return null;
    }
  }
  const loaded = base;
  return (words, context) => {
    const lines = linesFromWordsByGeometry(words);
    if (!lines.length) return [];
    const res = detectCsiV2({ lines, context }, { tau: DEFAULT_CSI_V2_CONFIG.tau, maxCodesPerPage: CSI_V2_MAX_CODES_MAX }, loaded);
    return res.codes.map((c) => ({ code: c.code, division: c.division }));
  };
}
