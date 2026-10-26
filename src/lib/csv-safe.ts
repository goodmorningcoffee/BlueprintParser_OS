/**
 * CSV cell escaping that is safe to open in a spreadsheet (TP-1 WP-1.C, K64).
 *
 * Spreadsheet apps evaluate a cell that starts with `=`, `+`, `-` or `@` (and, after a leading tab
 * or carriage return, the same) as a formula, quoted or not. Parsed table cells, takeoff names and
 * notes are user- or drawing-supplied text, so an export must neutralise them: the cell gets a
 * leading apostrophe, which every spreadsheet shows as text.
 *
 * Two shapes are left as they are because they are not formulas and are common in schedules: a
 * plain signed number (`-5`, `+0.25`, `-1,200`) and a run of dashes (`-`, `--`, the "none" mark).
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_SIGNED_NUMBER = /^[+-](\d+([.,]\d+)*|\.\d+)$/;
const DASHES_ONLY = /^-+$/;

/** Prefix `'` when the cell would be read as a formula; otherwise return it unchanged. */
export function neutraliseCsvFormula(val: string): string {
  if (!FORMULA_LEAD.test(val)) return val;
  if (PLAIN_SIGNED_NUMBER.test(val) || DASHES_ONLY.test(val)) return val;
  return `'${val}`;
}

/** Escape one CSV cell: neutralise a formula lead, then quote when it holds `,` `"` or a line break. */
export function escCsvSafe(val: string): string {
  const safe = neutraliseCsvFormula(val);
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/** Always-quoted variant, for writers whose columns are quoted unconditionally (takeoff CSV). */
export function csvQuotedSafe(val: string): string {
  return `"${neutraliseCsvFormula(val).replace(/"/g, '""')}"`;
}
