/**
 * certificate.ts — [tag-mapping v2 2026-10-24] The completeness certificate: schedule quantity vs
 * counted plan instances, per tag and (when the schedule names sheets) per sheet.
 *
 * research/archive_ideas/REPORT.md I-1 (THE_LABELED_BLUEPRINT §6, labelfactory reconcile.py): a
 * (sheet, tag) pair is certified complete only when the schedule's expected count equals the found
 * count; an uncertified pair's unlabelled true symbols are hard negatives for any training export.
 * An `enumerating` grid (type catalog) carries no cardinality — "LI01 found 47× is CORRECT for a
 * type catalog" — so its verdict is NO-QTY with the presence recorded in `found`.
 */

import type { GridKind } from "./schedule-rules";
import { parseQuantity } from "./schedule-rules";

export type CertificateVerdict = "MATCH" | "MISMATCH" | "NO-QTY";

export interface CompletenessCertificate {
  tag: string;
  verdict: CertificateVerdict;
  /** Parsed schedule quantity; null when the row has none (or the grid is enumerating). */
  expected: number | null;
  /** Counted instances over the certificate's grain. */
  found: number;
  grid: GridKind;
  /** "sheet" when the schedule row names a sheet the project has; else "project". */
  grain: "project" | "sheet";
  /** The sheet (drawing number) the certificate is scoped to, for sheet grain. */
  sheet?: string;
  /** Instances per drawing number ("p<n>" for pages whose drawing number is unknown). */
  bySheet: Record<string, number>;
}

export interface CertificateInput {
  tag: string;
  /** The row's quantity cell, raw. */
  quantityRaw?: string | null;
  /** The row's sheet / location cell, raw (sheet grain when it names a project sheet). */
  sheetRaw?: string | null;
  grid: GridKind;
  instances: ReadonlyArray<{ pageNumber: number }>;
  /** pageNumber → drawing number. */
  drawingNumbers: Readonly<Record<number, string | null | undefined>>;
}

const key = (s: string | null | undefined): string => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function buildCompletenessCertificate(input: CertificateInput): CompletenessCertificate {
  const bySheet: Record<string, number> = {};
  for (const inst of input.instances) {
    const sheet = input.drawingNumbers[inst.pageNumber] || `p${inst.pageNumber}`;
    bySheet[sheet] = (bySheet[sheet] ?? 0) + 1;
  }
  const sheetKey = key(input.sheetRaw);
  const sheetMatch = sheetKey
    ? Object.values(input.drawingNumbers).find((d) => key(d) === sheetKey) ?? null
    : null;
  const grain: CompletenessCertificate["grain"] = sheetMatch ? "sheet" : "project";
  const found = sheetMatch ? (bySheet[sheetMatch] ?? 0) : input.instances.length;
  const expected = input.grid === "qty" ? parseQuantity(input.quantityRaw) : null;
  const verdict: CertificateVerdict = expected == null ? "NO-QTY" : expected === found ? "MATCH" : "MISMATCH";
  return {
    tag: input.tag, verdict, expected, found, grid: input.grid, grain,
    ...(sheetMatch ? { sheet: sheetMatch } : {}),
    bySheet,
  };
}

/** Short badge text: "qty 4/4", "qty 3≠4", or null for NO-QTY. */
export function certificateLabel(c: CompletenessCertificate | undefined | null): string | null {
  if (!c || c.verdict === "NO-QTY" || c.expected == null) return null;
  return c.verdict === "MATCH" ? `qty ${c.found}/${c.expected}` : `qty ${c.found}≠${c.expected}`;
}
