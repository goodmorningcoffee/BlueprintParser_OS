/**
 * csi-utils.ts
 *
 * Shared CSI code utilities — safe for both client and server.
 * No Node.js imports (no fs, path, etc.)
 */

import type { CsiCode } from "@/types";

/**
 * Normalize a CSI code input to canonical space-separated format.
 * Accepts: "8", "08", "080000", "08 00 00", "08-00-00", "08.00.00", "023321", etc.
 * Returns: "08", "08 00", "08 00 00", "02 33 21" (space-separated canonical form)
 */
export function normalizeCsiCode(input: string): string {
  const stripped = input.replace(/[\s.\-]/g, "").toUpperCase();
  if (!stripped || !/^\d+$/.test(stripped)) return input.trim();
  if (stripped.length <= 2) return stripped.padStart(2, "0");
  if (stripped.length <= 4) return `${stripped.slice(0, 2)} ${stripped.slice(2).padStart(2, "0")}`;
  return `${stripped.slice(0, 2)} ${stripped.slice(2, 4)} ${stripped.slice(4, 6).padStart(2, "0")}`;
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

/** CSI code input placeholder text */
export const CSI_INPUT_PLACEHOLDER = "e.g. 08, 08 11 16, 080000";

/**
 * Idempotently merge a list of incoming CSI tags into an existing CsiCode[].
 *
 * Used server-side by `/api/pages/intelligence` (PATCH) and `/api/regions/promote`
 * (POST) so both endpoints write consistent page-level csiCodes after a
 * ParsedRegion is accepted or promoted.
 *
 * Incoming tags may arrive with only `{code, description}` (from a parsed grid's
 * CSI detection output). Missing `division` is derived from the first two
 * characters of the code; missing `trade` defaults to empty string.
 *
 * Behavior: dedupes by `csiDedupeKey(code)` — a code whose separator-stripped
 * form already appears in `existing` (or earlier in `incoming`) is never added,
 * so pure format variants ("08 11 13" vs "081113") collapse to one entry.
 * [refactor jul23 P4.1 U9] The key is separator-strip-only (NOT normalizeCsiCode)
 * to avoid truncating distinct Level-4 dotted siblings into a collision — see
 * csiDedupeKey. First-seen wins: the RAW `.code` of the first occurrence is kept
 * verbatim (existing rows are spread unchanged; new codes keep their arriving
 * format). Safe to call repeatedly with the same inputs.
 */
export function mergeCsiCodes(
  existing: CsiCode[],
  incoming: ReadonlyArray<{ code: string; description: string; division?: string; trade?: string }>,
): CsiCode[] {
  const seen = new Set(existing.map((c) => csiDedupeKey(c.code)));
  const merged: CsiCode[] = [...existing];
  for (const tag of incoming) {
    if (!tag.code) continue;
    const key = csiDedupeKey(tag.code);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      code: tag.code,
      description: tag.description,
      division: tag.division ?? tag.code.substring(0, 2),
      trade: tag.trade ?? "",
    });
  }
  return merged;
}
