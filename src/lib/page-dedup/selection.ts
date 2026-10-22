// Duplicate pages — the admin's selection model (owner 2026-10-22: "select all for the
// partially-confident duplicate pages"). Pure; the Data tools UI and its tests use it, and the
// apply-selection service re-plans every unit from a fresh report under the project lock.
//
// A unit is what one checkbox removes: a block (repeat set / likely revision set, any tier) or
// a lone pair (blockId null — before this, near/possible lone pairs had no removal path).
// Score = the bulk-gate score: a block's minFull, a pair's full (whole-text Jaccard).
//
// Exact units are selected by default, except in a project on bulkHold (it shows revision
// evidence; the admin opts its units in explicitly). Nothing below exact is ever selected
// without an admin action (a band "Select all", a threshold, or a checkbox).

import { defaultKeep } from "./detect";
import type { DuplicateBlock, DuplicateKeep, DuplicatePair, DuplicateTier } from "./types";

export interface SelectionUnit {
  /** "b:<blockId>" or "p:<page>" — unique within a project. */
  key: string;
  kind: "block" | "pair";
  tier: DuplicateTier;
  /** minFull (block) or full (pair), 0..1. */
  score: number;
  /** Pages this unit hides. */
  pages: number;
  blockId: string | null;
  page: number | null;
}

/** The fields of a scan report line the selection reads. */
export interface SelectableReport {
  blocks: readonly DuplicateBlock[];
  pairs: readonly DuplicatePair[];
  bulkHold: string | null;
}

export type SelectionMap = Record<string, boolean>;

export function selectionUnits(report: SelectableReport): SelectionUnit[] {
  const units: SelectionUnit[] = report.blocks.map((b) => ({
    key: `b:${b.id}`, kind: "block", tier: b.tier, score: b.minFull, pages: b.length, blockId: b.id, page: null,
  }));
  for (const p of report.pairs) {
    if (p.blockId !== null) continue;
    units.push({ key: `p:${p.page}`, kind: "pair", tier: p.tier, score: p.full, pages: 1, blockId: null, page: p.page });
  }
  return units;
}

/** Exact units of a project not on hold. */
export function defaultSelection(report: SelectableReport): SelectionMap {
  const out: SelectionMap = {};
  if (report.bulkHold) return out;
  for (const u of selectionUnits(report)) if (u.tier === "exact") out[u.key] = true;
  return out;
}

/** Select (or clear) every unit of one tier. */
export function selectBand(report: SelectableReport, current: SelectionMap, tier: DuplicateTier, on: boolean): SelectionMap {
  const out = { ...current };
  for (const u of selectionUnits(report)) if (u.tier === tier) out[u.key] = on;
  return out;
}

/** Add every unit whose score ≥ `min` (0..1); leaves other selections as they are. */
export function selectAtLeast(report: SelectableReport, current: SelectionMap, min: number): SelectionMap {
  const out = { ...current };
  for (const u of selectionUnits(report)) if (u.score >= min) out[u.key] = true;
  return out;
}

export function selectedUnits(report: SelectableReport, current: SelectionMap): SelectionUnit[] {
  return selectionUnits(report).filter((u) => current[u.key]);
}

/** Default keep for a unit: exact keeps the first copy, everything else the latest. */
export function unitDefaultKeep(unit: Pick<SelectionUnit, "tier">): DuplicateKeep {
  return defaultKeep(unit.tier);
}

export interface SelectionRequest {
  blocks: { id: string; keep: DuplicateKeep }[];
  pairs: { page: number; keep: DuplicateKeep }[];
}

/** The apply-selection body for one project. `keep` is keyed by unit key; absent → default. */
export function selectionRequest(
  report: SelectableReport,
  current: SelectionMap,
  keep: Readonly<Record<string, DuplicateKeep>> = {},
): SelectionRequest {
  const out: SelectionRequest = { blocks: [], pairs: [] };
  for (const u of selectedUnits(report, current)) {
    const k = keep[u.key] ?? unitDefaultKeep(u);
    if (u.kind === "block") out.blocks.push({ id: u.blockId!, keep: k });
    else out.pairs.push({ page: u.page!, keep: k });
  }
  return out;
}

/** Which page a lone pair hides: `earliest` keeps the lower page number. */
export function pairHide(pair: Pick<DuplicatePair, "page" | "canonical">, keep: DuplicateKeep): { page: number; canonical: number } {
  const lo = Math.min(pair.page, pair.canonical);
  const hi = Math.max(pair.page, pair.canonical);
  return keep === "earliest" ? { page: hi, canonical: lo } : { page: lo, canonical: hi };
}
