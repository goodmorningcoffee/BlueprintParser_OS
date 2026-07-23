// [refactor jul23 P4.1 U0] CSI-code shape schemas.
//
// Three co-existing csiCodes representations exist in the codebase (recon
// regionsCsiZod §"THREE co-existing"): (A) pages.csiCodes = CsiCode[] objects
// WITH triggers; (B) annotations.data.csiCodes = string[] (lightweight tag list,
// STAYS string[] per spec Verdict 3); (C) region csiTags = CsiCode-ish objects
// pre-mergeCsiCodes (trade/division may be missing until merged).
//
// All object schemas here are `.loose()` (spec Verdict 1 / RD-A): mergeCsiCodes
// fills missing division/trade and legacy blobs may carry extra keys — a strict
// schema would strip/reject them. The schema.ts:407 `$type` drift fix (restoring
// `triggers` on the persisted CsiCode type) is a U9 concern (RD-B) and is NOT
// done here; these schemas simply describe reality accurately (triggers optional).
import { z } from "zod";
import { zBboxLTWH } from "./primitives";

/** == CsiCodeTrigger (types/index.ts:331). `.loose()` per Verdict 1. */
export const zCsiCodeTrigger = z
  .object({
    text: z.string(),
    bbox: zBboxLTWH, // LTWH [left,top,width,height], normalized 0-1
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .loose();
export type CsiCodeTrigger = z.infer<typeof zCsiCodeTrigger>;

/**
 * == CsiCode (types/index.ts:337). `triggers` is optional — persisted ONLY on
 * the text-detect pipeline paths (processing/reprocess/recompute); mergeCsiCodes-
 * and yolo-written codes carry none (recon CsiCode_PersistedObject crossSiteDrift).
 * `triggers?: undefined` = "unknown / pre-triggers legacy", distinct from `[]`.
 * `.loose()` so mergeCsiCodes-derived and legacy extra keys survive.
 */
export const zCsiCode = z
  .object({
    code: z.string(),
    description: z.string(),
    trade: z.string(),
    division: z.string(),
    triggers: z.array(zCsiCodeTrigger).optional(),
  })
  .loose();
export type CsiCode = z.infer<typeof zCsiCode>;

/** Shape A: the `pages.csiCodes` column (CsiCode[] objects with triggers). */
export const zPageCsiCodes = z.array(zCsiCode);

/** Shape B: `annotations.data.csiCodes` — STAYS string[] (spec Verdict 3). */
export const zCsiCodeStringList = z.array(z.string());

/**
 * Shape C: region `csiTags` BEFORE mergeCsiCodes normalizes them. mergeCsiCodes
 * (csi-utils.ts:48-62) tolerates incoming tags with only {code,description} and
 * derives division=code[0:2], trade="" — so description/trade/division are all
 * optional here (read side must tolerate the pre-merge shape). `.loose()`.
 */
export const zCsiTag = z
  .object({
    code: z.string(),
    description: z.string().optional(),
    trade: z.string().optional(),
    division: z.string().optional(),
    triggers: z.array(zCsiCodeTrigger).optional(),
  })
  .loose();
export type CsiTag = z.infer<typeof zCsiTag>;
