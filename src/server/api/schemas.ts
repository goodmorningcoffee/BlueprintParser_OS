// [refactor jun16 P1.1] Shared zod primitives for route bodies/queries.
//
// First-class validation lives here so the 0-zod-uses / hand-rolled-per-route state
// (01 §4.1) collapses to a handful of reused schemas. Colocate route-specific bodies with
// their services; put cross-cutting primitives here.

import { z } from "zod";

/**
 * projects.publicId / pages.publicId / annotation_groups.publicId are pg `uuid` columns.
 * Validating as uuid REJECTS a non-uuid id with a 400 at the shell — which CLOSES the
 * S003 quirk where a non-uuid publicId reached resolveProjectAccess and threw a pg
 * uuid-cast error = unhandled 500. The fix falls out of using the schema, not a special case.
 */
export const zPublicId = z.string().uuid();

/** 1-based page number. */
export const zPageNumber = z.number().int().min(1);

/** Human name field — trimmed, non-empty, ≤255 chars (the schema.ts varchar bound). */
export const zName255 = z.string().trim().min(1).max(255);

/**
 * MinMax bbox in normalized [0,1] coords, ordered [minX, minY, maxX, maxY].
 * Mirrors api-utils.parseBboxMinMax EXACTLY (the behavior P0.3 froze): four finite
 * numbers in [0,1], strictly minX<maxX and minY<maxY.
 */
export const zBboxMinMax = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((v) => v.every((n) => Number.isFinite(n) && n >= 0 && n <= 1), {
    message: "bbox values must be finite numbers in [0, 1]",
  })
  .refine(([minX, minY, maxX, maxY]) => minX < maxX && minY < maxY, {
    message: "bbox: minX must be < maxX and minY must be < maxY",
  });

/**
 * Page-window range with a HARD CAP. The cap is the export-DoS ceiling (01 §4.1 export
 * DoS) and matches the 50-page window contract frozen for pages-window in P0.3 — the cap
 * "falls out for free" (02 §4.1) instead of being re-checked per route.
 */
export const MAX_PAGE_RANGE = 50;
export const zPageRange = z
  .object({ from: zPageNumber, to: zPageNumber })
  .refine(({ from, to }) => to >= from, { message: "to must be >= from" })
  .refine(({ from, to }) => to - from + 1 <= MAX_PAGE_RANGE, {
    message: `page range exceeds the ${MAX_PAGE_RANGE}-page cap`,
  });

export type BboxMinMaxInput = z.infer<typeof zBboxMinMax>;
export type PageRangeInput = z.infer<typeof zPageRange>;
