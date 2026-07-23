// [refactor jul23 P4.1 U0] Shape-registry shared leaf primitives.
//
// U0 is PURE-ADDITIVE (RD-B): new files only, no wiring, no source edits.
// Zod idiom is `.loose()` (RD-A): repo is zod 4.3.6 where `.passthrough()` is
// @deprecated; `.loose()` is the non-deprecated form with IDENTICAL semantics
// (unknown keys preserved, core.$loose). The ONLY admissible `.strict()` is the
// one the split contract already proved — `zNormalizedPoint` below, lifted from
// annotation-split-contract.ts:190-192 (spec Verdict 1).
import { z } from "zod";
import { TAKEOFF_SHAPES } from "@/types";

/** 0-1 normalized coordinate. == annotation-split-contract.ts:189 (VERIFIED). */
export const zNormalizedCoordinate = z.number().finite().min(0).max(1);

/**
 * A normalized {x,y} point. `.strict()` here is the sole admissible strict use
 * under spec Verdict 1: it is the exact leaf the split contract already froze
 * (`zSplitAnnotationPoint`, annotation-split-contract.ts:190-192). Reusing that
 * proven-strict leaf keeps the two contracts byte-compatible.
 */
export const zNormalizedPoint = z
  .object({ x: zNormalizedCoordinate, y: zNormalizedCoordinate })
  .strict();

/**
 * Annotation/YOLO bbox = [minX, minY, maxX, maxY], normalized 0-1.
 * NOTE (extract §1 annotation): deliberately NO `minX<maxX` cross-field refine.
 * General annotation bboxes are not order-guaranteed at the registry tier; that
 * refine stays LOCAL to the split RPC (annotation-split-contract.ts:200-202).
 */
export const zBboxMinMax = z.tuple([
  zNormalizedCoordinate,
  zNormalizedCoordinate,
  zNormalizedCoordinate,
  zNormalizedCoordinate,
]);

/** Textract / CSI-trigger bbox = [left, top, width, height], normalized 0-1. */
export const zBboxLTWH = z.tuple([
  zNormalizedCoordinate,
  zNormalizedCoordinate,
  zNormalizedCoordinate,
  zNormalizedCoordinate,
]);

/** == annotation-split-contract.ts:184-188 (zPositiveSafeInteger). */
export const zPositiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/** Non-negative finite number (lengths, areas). */
export const zFiniteNonNegative = z.number().finite().nonnegative();

/** Color string. == split contract color bound (annotation-split-contract.ts:235). */
export const zColor = z.string().max(20);

/** Linear/scale unit. == AreaUnit (types/index.ts:125). Type-only union upstream;
 *  a compile-time Expect<Equal> guard in the unit net pins agreement. */
export const zAreaUnit = z.enum(["ft", "in", "m", "cm"]);

/** Squared area unit. == AreaUnitSq (types/index.ts:222). Type-only union upstream;
 *  guarded by Expect<Equal> in the unit net. */
export const zAreaUnitSq = z.enum(["SF", "SI", "SM", "SC"]);

/** Count-marker shape enum. Imports the runtime const array TAKEOFF_SHAPES
 *  (types/index.ts:113) rather than duplicating the literal list; an
 *  Expect<Equal> guard in the unit net pins agreement with the TakeoffShape type. */
export const zTakeoffShape = z.enum(TAKEOFF_SHAPES);
