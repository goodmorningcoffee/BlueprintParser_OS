/**
 * csi-utils.ts
 *
 * Shared CSI code utilities — safe for both client and server.
 * No Node.js imports (no fs, path, etc.)
 */

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
