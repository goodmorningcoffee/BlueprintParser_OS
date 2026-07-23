// [refactor jul23 P4.1 U0] ParsedRegion.data blob schemas + sniff classifier.
//
// ParsedRegion.data is one of ScheduleData|KeynoteData|LegendData|NotesData|
// SpecData (types/index.ts:734). The server binder emits grid/spec shapes, but
// Parser-Save (regions.ts:285-286) persists client `overrides.data` VERBATIM and
// UNVALIDATED across 7 client writer sites (recon regionsCsiZod), so non-grid
// Keynote/Legend/hybrid shapes CAN land in the column. Every schema is `.loose()`
// (spec Verdict 1 / RD-A) so extra/legacy keys survive.
//
// U0 is schemas + classifier + types ONLY (RD-K): no upgraders, no wiring.
import { z } from "zod";
import { zCsiTag } from "./csi";

/** Canonical in-blob version marker (parallels ANNOTATION_DATA_VERSION). */
export const REGION_DATA_VERSION = 1 as const;

/**
 * Grid branch — ScheduleData ∪ NotesData-grid (server regions.ts:271-280;
 * ScheduleData types/index.ts:761, NotesData grid fields :787-796). headers/rows
 * are the only reliably-present keys; the server always emits tagColumn +
 * colBoundaries/rowBoundaries KEYS but ScheduleData marks them optional and
 * client writers omit them conditionally → all optional here (read-tolerance).
 */
export const zGridRegionData = z
  .object({
    headers: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.string())),
    tagColumn: z.string().optional(),
    tableName: z.string().optional(),
    rowCount: z.number().int().nonnegative().optional(),
    columnCount: z.number().int().nonnegative().optional(),
    colBoundaries: z.array(z.number()).optional(),
    rowBoundaries: z.array(z.number()).optional(),
  })
  .loose();
export type GridRegionData = z.infer<typeof zGridRegionData>;

/**
 * Spec branch — `satisfies SpecData` at regions.ts:231-235 (SpecData
 * types/index.ts:807). Server always sets tableName + csiTags, both optional on
 * the type and one client site omits csiTags (SpecParser:297) → optional.
 */
export const zSpecRegionData = z
  .object({
    sections: z.array(
      z.object({ sectionHeader: z.string(), body: z.string() }).loose(),
    ),
    tableName: z.string().optional(),
    csiTags: z.array(zCsiTag).optional(),
  })
  .loose();
export type SpecRegionData = z.infer<typeof zSpecRegionData>;

/** Keynote branch — KeynoteData (types/index.ts:773). Hybrid client writers
 *  (KeynotePanel:236) additionally carry grid fields; `.loose()` tolerates them. */
export const zKeynoteRegionData = z
  .object({
    keynotes: z.array(
      z
        .object({
          key: z.string(),
          description: z.string(),
          shapeClass: z.string().optional(),
        })
        .loose(),
    ),
    isPageSpecific: z.boolean(),
  })
  .loose();
export type KeynoteRegionData = z.infer<typeof zKeynoteRegionData>;

/** Legend branch — LegendData (types/index.ts:778). */
export const zLegendRegionData = z
  .object({
    symbols: z.array(
      z.object({ yoloClass: z.string(), description: z.string() }).loose(),
    ),
  })
  .loose();
export type LegendRegionData = z.infer<typeof zLegendRegionData>;

/**
 * Legacy notes — pre-Stage-3 NotesData shape ({title, notes[], isBoilerplate[]},
 * types/index.ts:799-801). All-optional and lenient: post-Stage-3 notes use the
 * grid shape (zGridRegionData); this covers the surviving legacy rows.
 */
export const zNotesLegacyRegionData = z
  .object({
    title: z.string().optional(),
    notes: z.array(z.string()).optional(),
    isBoilerplate: z.array(z.boolean()).optional(),
  })
  .loose();
export type NotesLegacyRegionData = z.infer<typeof zNotesLegacyRegionData>;

/** Legacy / arbitrary passthrough fallback — any object parses. */
export const zUnknownRegionData = z.record(z.string(), z.unknown());

/**
 * The region-data union. NOTE the members overlap heavily (grid-notes and
 * schedule are structurally identical), so this is a "parses at all" union;
 * attribution uses classifyRegionData below.
 */
export const zRegionData = z.union([
  zGridRegionData,
  zSpecRegionData,
  zKeynoteRegionData,
  zLegendRegionData,
  zNotesLegacyRegionData,
  zUnknownRegionData,
]);
export type RegionDataUnion = z.infer<typeof zRegionData>;

// ─── Classifier (best-effort structural sniff) ───────────────

/** Region classifier verdict — keys of REGION_SCHEMAS. */
export type RegionDataKind =
  | "spec"
  | "legend"
  | "keynote"
  | "grid"
  | "notes-legacy"
  | "unknown";

export const REGION_SCHEMAS = {
  spec: zSpecRegionData,
  legend: zLegendRegionData,
  keynote: zKeynoteRegionData,
  grid: zGridRegionData,
  "notes-legacy": zNotesLegacyRegionData,
  unknown: zUnknownRegionData,
} as const;

/**
 * Attribute a raw ParsedRegion.data value to a shape by STRUCTURAL SNIFF.
 *
 * Unlike annotation data, region data has NO in-blob discriminant: the real
 * discriminator is ParsedRegion.type (schedule|keynote|legend|notes|spec), which
 * lives OUTSIDE the data blob (types/index.ts:729). Worse, schedule and the
 * Stage-3 notes grid share an IDENTICAL {headers,rows,...} shape — they are
 * indistinguishable from `data` alone. So this classifier is a best-effort sniff
 * on presence of the shape-unique keys, resolved most-specific first; both
 * schedule and grid-notes necessarily collapse to "grid". Callers that know the
 * ParsedRegion.type should prefer it. NEVER throws.
 *
 * Order: sections→spec; symbols→legend; keynotes→keynote; headers+rows→grid;
 * legacy notes[]→notes-legacy; else unknown.
 */
export function classifyRegionData(data: unknown): RegionDataKind {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "unknown";
  }
  const d = data as Record<string, unknown>;

  if (Array.isArray(d.sections)) return "spec";
  if (Array.isArray(d.symbols)) return "legend";
  if (Array.isArray(d.keynotes)) return "keynote";
  if (Array.isArray(d.headers) && Array.isArray(d.rows)) return "grid";
  if (Array.isArray(d.notes)) return "notes-legacy";
  return "unknown";
}
