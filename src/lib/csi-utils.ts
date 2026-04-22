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
 * Behavior: dedupes by `code` — codes already present in `existing` are never
 * overwritten. Safe to call repeatedly with the same inputs.
 */
export function mergeCsiCodes(
  existing: CsiCode[],
  incoming: ReadonlyArray<{ code: string; description: string; division?: string; trade?: string }>,
): CsiCode[] {
  const seen = new Set(existing.map((c) => c.code));
  const merged: CsiCode[] = [...existing];
  for (const tag of incoming) {
    if (!tag.code || seen.has(tag.code)) continue;
    seen.add(tag.code);
    merged.push({
      code: tag.code,
      description: tag.description,
      division: tag.division ?? tag.code.substring(0, 2),
      trade: tag.trade ?? "",
    });
  }
  return merged;
}
