/**
 * Page CSI that can SHRINK (table pipeline K50; PLAN §5 WP-3.G step 9, region delete).
 *
 * `pages.csi_codes` is a merged list with no per-code owner: promote and the intelligence PATCH only ever
 * `mergeCsiCodes` region tags in (union-only), and the classic `DELETE /api/regions` leaves them, so a
 * replaced or deleted region's codes stayed on the page forever. The plan's rule is
 *   page CSI = trigger-bearing text codes ∪ YOLO class codes ∪ ⋃ current regions' csiTags.
 *
 * Provenance, as VERIFIED in code (2026-10-28):
 *   - text detection (`detectCsiCodes` with lines/words: upload, re-OCR, csi-recompute, reprocess) runs the
 *     engine with geometry, so every row it emits carries a `triggers` ARRAY (possibly empty) — `toRow` in
 *     `lib/csi-detect.ts`;
 *   - YOLO class codes are merged with `description: "From YOLO class config"` (`YOLO_CSI_DESCRIPTION`);
 *   - region codes (`detectCsiFromGrid`, `detectCsiCodes(text)` without words, user picks) carry NO `triggers`,
 *     and `mergeCsiCodes` never copies `triggers` onto a code it adds.
 * Pre-trigger data (before csi-v2) has text codes without `triggers`, indistinguishable from region codes. So
 * the rule is applied CONSERVATIVELY: a code is removed only when it was one of the removed/replaced region's
 * own codes, is not trigger-bearing, not a YOLO code, and no remaining region on the page carries it. A
 * pre-trigger text code that coincides with a removed region's code is the one residual (reported open).
 */

import { mergeCsiCodes, csiDedupeKey } from "@/lib/csi-utils";
import type { CsiCode } from "@/types";
import { YOLO_CSI_DESCRIPTION } from "@/server/services/reprocess-yolo-csi";

type CodeLike = { code?: unknown };

const keyOf = (c: CodeLike): string | null => (typeof c?.code === "string" && c.code ? csiDedupeKey(c.code) : null);

/** A code the page owns independently of any parsed region (text detection or a YOLO class). */
export function isPageOwnedCsi(code: CsiCode): boolean {
  return Array.isArray(code.triggers) || code.description === YOLO_CSI_DESCRIPTION;
}

function keysOf(list: readonly CodeLike[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of list ?? []) {
    const k = keyOf(c);
    if (k) out.add(k);
  }
  return out;
}

/**
 * The page's codes after `removed` region tags are taken away and `added` region tags merged in.
 * `remaining` = the csiTags of every region that stays on the page (the new one included).
 * Pure; never mutates its inputs; order of the kept codes is preserved.
 */
export function pageCsiAfterRegionChange(
  existing: readonly CsiCode[] | null | undefined,
  removed: readonly CodeLike[] | null | undefined,
  remaining: readonly (readonly CodeLike[] | null | undefined)[],
  added: readonly CsiCode[] = [],
): CsiCode[] {
  const gone = keysOf(removed);
  for (const list of remaining) for (const k of keysOf(list)) gone.delete(k);
  for (const k of keysOf(added)) gone.delete(k);
  const kept = (existing ?? []).filter((c) => {
    const k = keyOf(c);
    return !k || !gone.has(k) || isPageOwnedCsi(c);
  });
  return mergeCsiCodes(kept, added);
}
