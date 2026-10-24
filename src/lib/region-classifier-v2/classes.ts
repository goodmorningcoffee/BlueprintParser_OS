/**
 * region-classifier-v2/classes.ts — the editable class table (src/data/region-classes.v2.json).
 *
 * Same row schema as corpus_v2's `regions_rc_classes.json` / `regions_rc2_classes.json`, merged
 * into one file: `tables` (yolo_medium `tables` anchors) and `text` (symbol_legend / text_box
 * anchors, plus the fallback checklist). Validated structurally at load; a malformed file throws
 * at import time rather than silently naming nothing. `classesHash` is written into every
 * `regionsV2` record so a stored result says which table produced it.
 */

import rawTable from "@/data/region-classes.v2.json";

export interface ClassRules {
  min_score: number;
  min_keywords: number;
  csi_weight: number;
  csi_min_codes: number;
  titleblock_weight: number;
  sheet_yolo_weight?: number;
  tag_weight?: number;
  tag_min?: number;
  schedule_word_weight?: number;
}

export interface ClassRow {
  name: string;
  keywords: Record<string, number>;
  csi_divisions?: string[];
  titleblock_plus?: string[];
  titleblock_minus?: string[];
  tags_expected?: boolean;
  sheet_yolo_plus?: string[];
  is_schedule?: boolean;
}

export interface FallbackRule {
  name: string;
  if_rebuilt_table?: boolean;
  max_words?: number;
  min_words?: number;
  min_hits?: number;
  csi_min?: number;
  csi_or_words?: boolean;
  words?: string[];
  digits_share?: number;
}

export interface FallbackTable {
  rules: FallbackRule[];
  /** Fallback names that describe page labels, not regions — such boxes are dropped. */
  labelClasses?: string[];
}

export interface ClassFamily {
  rules: ClassRules;
  classes: ClassRow[];
  fallback?: FallbackTable;
}

export interface RegionClassTable {
  version: string;
  tables: ClassFamily;
  text: ClassFamily;
}

/** Prepared row: upper-cased single-word and phrase keyword maps, like regions_rc.py `load_classes`. */
export interface PreparedRow extends ClassRow {
  kw1: Record<string, number>;
  kwp: Record<string, number>;
  tbp: string[];
  tbm: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assertFamily(v: unknown, label: string): asserts v is ClassFamily {
  if (!isRecord(v) || !isRecord(v.rules) || !Array.isArray(v.classes)) {
    throw new Error(`region-classes.v2.json: "${label}" needs {rules, classes[]}`);
  }
  for (const k of ["min_score", "min_keywords", "csi_weight", "csi_min_codes", "titleblock_weight"]) {
    if (typeof v.rules[k] !== "number") throw new Error(`region-classes.v2.json: ${label}.rules.${k} must be a number`);
  }
  const names = new Set<string>();
  for (const row of v.classes) {
    if (!isRecord(row) || typeof row.name !== "string" || !isRecord(row.keywords)) {
      throw new Error(`region-classes.v2.json: every ${label} class row needs {name, keywords}`);
    }
    if (names.has(row.name)) throw new Error(`region-classes.v2.json: duplicate ${label} class "${row.name}"`);
    names.add(row.name);
    for (const [k, w] of Object.entries(row.keywords)) {
      if (typeof w !== "number") throw new Error(`region-classes.v2.json: ${label} "${row.name}" keyword "${k}" weight must be a number`);
    }
  }
}

export function validateClassTable(v: unknown): RegionClassTable {
  if (!isRecord(v) || typeof v.version !== "string") throw new Error("region-classes.v2.json: missing version");
  assertFamily(v.tables, "tables");
  assertFamily(v.text, "text");
  return v as unknown as RegionClassTable;
}

/** FNV-1a 32-bit over the JSON text — a provenance stamp, not a security hash. */
export function hashClassTable(table: RegionClassTable): string {
  const s = JSON.stringify({ tables: table.tables, text: table.text });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function prepareRows(rows: readonly ClassRow[]): PreparedRow[] {
  return rows.map((r) => {
    const kw1: Record<string, number> = {};
    const kwp: Record<string, number> = {};
    for (const [k, w] of Object.entries(r.keywords)) {
      const key = k.toUpperCase();
      if (key.includes(" ")) kwp[key] = w; else kw1[key] = w;
    }
    return {
      ...r,
      kw1,
      kwp,
      tbp: (r.titleblock_plus ?? []).map((k) => k.toUpperCase()),
      tbm: (r.titleblock_minus ?? []).map((k) => k.toUpperCase()),
    };
  });
}

export const REGION_CLASS_TABLE: RegionClassTable = validateClassTable(rawTable);
export const REGION_CLASSES_HASH = hashClassTable(REGION_CLASS_TABLE);
export const TABLE_ROWS: readonly PreparedRow[] = prepareRows(REGION_CLASS_TABLE.tables.classes);
export const TEXT_ROWS: readonly PreparedRow[] = prepareRows(REGION_CLASS_TABLE.text.classes);
