/**
 * csi-utils.ts
 *
 * Shared CSI code utilities — safe for both client and server.
 * No Node.js imports (no fs, path, etc.)
 */

import type { BboxLTWH, CsiCode, CsiCodeTrigger, SearchWordMatch } from "@/types";

/**
 * Normalize a CSI code input to canonical space-separated format.
 * Accepts: "8", "08", "080000", "08 00 00", "08-00-00", "08.00.00", "023321", etc.
 * Returns: "08", "08 00", "08 00 00", "02 33 21" (space-separated canonical form)
 *
 * [csi-v2 S6] Level-5 codes keep their ".NN" suffix: "00 24 13.16" / "00241316" /
 * "00.24.13.16" → "00 24 13.16" (was truncated to "00 24 13", which merged two distinct
 * siblings). Digits past the 8th are dropped, as digits past the 6th used to be.
 */
export function normalizeCsiCode(input: string): string {
  const stripped = input.replace(/[\s.\-]/g, "").toUpperCase();
  if (!stripped || !/^\d+$/.test(stripped)) return input.trim();
  if (stripped.length <= 2) return stripped.padStart(2, "0");
  if (stripped.length <= 4) return `${stripped.slice(0, 2)} ${stripped.slice(2).padStart(2, "0")}`;
  const level4 = `${stripped.slice(0, 2)} ${stripped.slice(2, 4)} ${stripped.slice(4, 6).padStart(2, "0")}`;
  return stripped.length <= 6 ? level4 : `${level4}.${stripped.slice(6, 8).padStart(2, "0")}`;
}

/**
 * Normalize a comma-separated list of CSI codes.
 * "8, 080000, 02 33 21" → ["08", "08 00 00", "02 33 21"]
 */
export function normalizeCsiCodes(input: string): string[] {
  return input.split(",").map(s => normalizeCsiCode(s.trim())).filter(Boolean);
}

/**
 * Dedupe key for a CSI code — separator-strip-only, uppercased.
 *
 * [refactor jul23 P4.1 U9] Collapses pure FORMAT variants of one logical code
 * ("08 11 13" / "081113" / "08-11-13" / "08.11.13" → "081113") so mergeCsiCodes
 * can recognize them as the same code, WITHOUT the truncation that
 * `normalizeCsiCode` applies. This distinction is load-bearing: `normalizeCsiCode`
 * slices to the first 6 digits, which would map two DISTINCT Level-4 dotted
 * siblings ("00 24 13.13" and "00 24 13.16") to the same key and silently drop
 * one on merge — data loss. Keeping every digit ("00241313" != "00241316")
 * dedupes format variants while preserving genuinely different codes.
 *
 * Fallback: if the code contains no strippable digits (all-separator or empty,
 * or a non-numeric alphanumeric code), return the trimmed original so such codes
 * still compare on their own text rather than collapsing to "".
 */
export function csiDedupeKey(code: string): string {
  return code.replace(/[\s.\-]/g, "").toUpperCase() || code.trim();
}

/**
 * Does a CSI code match a free-text search query? [csi-v2 S6]
 * The description matches case-insensitively as a substring (unchanged). The CODE matches on
 * `csiDedupeKey`, so stored unspaced ("081113") and spaced ("08 11 13") codes both match the
 * queries "0811", "08 11" and "08-11-13" (a raw substring test missed the cross-format ones).
 */
export function csiCodeMatchesQuery(c: { code: string; description: string }, query: string): boolean {
  const q = query.toLowerCase();
  if (c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) return true;
  const qKey = query.replace(/[\s.\-]/g, "").toUpperCase();
  return qKey.length > 0 && csiDedupeKey(c.code).includes(qKey);
}

/**
 * Highlight boxes for a code's stored triggers. [csi-v2 S6] A v2 trigger may carry one box per
 * matched word (`bboxes`) besides the union `bbox`; draw the per-word boxes when present, else
 * the single `bbox` (every pre-v2 trigger). One hit per box, each labelled with the trigger text.
 */
export function csiTriggerHits(
  triggers: ReadonlyArray<CsiCodeTrigger & { bboxes?: BboxLTWH[] }>,
): SearchWordMatch[] {
  return triggers.flatMap((t) =>
    (t.bboxes && t.bboxes.length > 0 ? t.bboxes : [t.bbox]).map((bbox) => ({ text: t.text, bbox })),
  );
}

/**
 * The slim CSI payload handed to the chat LLM. [csi-v2 S6] `{code, description, trade,
 * confidence}` only: triggers (with their bboxes) and division are dropped to save tokens —
 * `getPageDetails` used to return the raw stored codes despite promising to omit bboxes.
 * `confidence` is present only when the code carries a number (pre-v2 data carries none).
 */
export function csiCodesForLlm(
  codes: ReadonlyArray<CsiCode> | null | undefined,
): { code: string; description: string; trade: string; confidence?: number }[] {
  return (codes ?? []).map((c) => {
    const conf = confidenceOf(c);
    const slim: { code: string; description: string; trade: string; confidence?: number } = {
      code: c.code, description: c.description, trade: c.trade,
    };
    if (conf !== undefined) slim.confidence = conf;
    return slim;
  });
}

/** CSI code input placeholder text */
export const CSI_INPUT_PLACEHOLDER = "e.g. 08, 08 11 16, 080000";

/**
 * The division a code belongs to, in the engine's "NN 00 00" form.
 * [csi-v2 S6] Accepts spaced and unspaced codes ("08 11 13", "081113", "08 11 13.16" → "08 00 00").
 * A code that does not start with two digits keeps the old 2-character prefix.
 */
export function csiDivisionOf(code: string): string {
  const prefix = csiDedupeKey(code).slice(0, 2);
  return /^\d\d$/.test(prefix) ? `${prefix} 00 00` : code.substring(0, 2);
}

/** The `confidence` a stored or incoming code carries, when it carries a finite number. */
function confidenceOf(c: object): number | undefined {
  return "confidence" in c && typeof c.confidence === "number" && Number.isFinite(c.confidence)
    ? c.confidence
    : undefined;
}

/**
 * Idempotently merge a list of incoming CSI tags into an existing CsiCode[].
 *
 * Used server-side by `/api/pages/intelligence` (PATCH) and `/api/regions/promote`
 * (POST) so both endpoints write consistent page-level csiCodes after a
 * ParsedRegion is accepted or promoted.
 *
 * Incoming tags may arrive with only `{code, description}` (from a parsed grid's
 * CSI detection output). Missing `division` is derived as "NN 00 00" from the code's
 * first two digits (`csiDivisionOf`; [csi-v2 S6] was the bare 2-character prefix "NN",
 * which disagreed with the engine's own "NN 00 00"); missing `trade` defaults to "".
 *
 * Behavior: dedupes by `csiDedupeKey(code)` — a code whose separator-stripped
 * form already appears in `existing` (or earlier in `incoming`) is never added,
 * so pure format variants ("08 11 13" vs "081113") collapse to one entry.
 * [refactor jul23 P4.1 U9] The key is separator-strip-only (NOT normalizeCsiCode)
 * to avoid truncating distinct Level-4 dotted siblings into a collision — see
 * csiDedupeKey. First-seen wins: the RAW `.code` of the first occurrence is kept
 * verbatim (new codes keep their arriving format). Safe to call repeatedly.
 *
 * [csi-v2 S6] `confidence` is carried: a new code keeps the incoming value, and a duplicate
 * raises the kept entry's confidence to the MAX of the two (the kept entry is copied, never
 * mutated). Codes without a numeric confidence (all pre-v2 data) are left exactly as they were.
 */
export function mergeCsiCodes(
  existing: CsiCode[],
  incoming: ReadonlyArray<{ code: string; description: string; division?: string; trade?: string; confidence?: number }>,
): CsiCode[] {
  const merged: CsiCode[] = [...existing];
  const indexByKey = new Map<string, number>();
  existing.forEach((c, i) => {
    const key = csiDedupeKey(c.code);
    if (!indexByKey.has(key)) indexByKey.set(key, i);
  });
  for (const tag of incoming) {
    if (!tag.code) continue;
    const key = csiDedupeKey(tag.code);
    const conf = confidenceOf(tag);
    const at = indexByKey.get(key);
    if (at !== undefined) {
      const kept = merged[at];
      const keptConf = confidenceOf(kept);
      if (conf !== undefined && (keptConf === undefined || conf > keptConf)) {
        const raised: CsiCode & { confidence: number } = { ...kept, confidence: conf };
        merged[at] = raised;
      }
      continue;
    }
    indexByKey.set(key, merged.length);
    const added: CsiCode & { confidence?: number } = {
      code: tag.code,
      description: tag.description,
      division: tag.division ?? csiDivisionOf(tag.code),
      trade: tag.trade ?? "",
    };
    if (conf !== undefined) added.confidence = conf;
    merged.push(added);
  }
  return merged;
}
