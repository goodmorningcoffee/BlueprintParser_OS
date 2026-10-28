/**
 * Crop-method evidence (table pipeline PLAN §1.3 E-3, §1.4; WP-3.E). A sibling type file (rule 13):
 * `types.ts` stays as WP-2.E froze it.
 *
 * The server run service (`server/services/parse-engine/run.ts`) gathers the heavy, crop-based evidence
 * BEFORE the engine is called (rule 11): Python rulings and img2table at `standard`, a paid Textract
 * crop and TATR at `thorough`. It hands the engine the page evidence plus `crops`, keyed by method.
 * `runParseEngine(evidence, request)` keeps its WP-2.E signature: the run service passes an
 * `EnginePageEvidenceWithCrops`, which is an `EnginePageEvidence` (structural typing), and the engine
 * (WP-3.D) reads `crops` when present.
 *
 * Every box is normalised MinMax on the FULL page (E-4): a crop result is mapped back from crop
 * coordinates before it is cached or handed over. Client-safe: imports only `./types`.
 */

import type { Budget, EnginePageEvidence, EngineTextractCell, EngineWord, BboxMinMax } from "./types";

/** A crop-based method. `textract` and `tatr` are paid / model calls (thorough); the others are standard. */
export type CropMethodId = "textract" | "rulings" | "img2table" | "tatr";
export const CROP_METHOD_IDS: readonly CropMethodId[] = ["textract", "rulings", "img2table", "tatr"];

/** The paid Textract crop in engine coordinates (words with their own line ids, tables 0-based). */
export interface CropTextractEvidence {
  words: EngineWord[];
  lines: { text: string; b: BboxMinMax; wordIdx: number[] }[];
  tables: { b: BboxMinMax; cells: EngineTextractCell[] }[];
}

/**
 * One method's crop outcome. `value` is the method's payload (`CropTextractEvidence` for `textract`;
 * the rulings / img2table / TATR shapes belong to the WPs that land those runners). A method that
 * failed or was skipped carries `error` and no value, and casts no vote (R1); the engine raises
 * `paid-evidence-skipped` when a paid method was asked for and has no value.
 */
export interface CropMethodOutcome {
  method: CropMethodId;
  budget: Exclude<Budget, "instant">;
  paid: boolean;
  /** The crop box actually used: the request box rounded to 3 dp (the cache key's box). */
  box: BboxMinMax;
  cached: boolean;
  value?: unknown;
  error?: string;
  ms?: number;
}

export interface EnginePageEvidenceWithCrops extends EnginePageEvidence {
  crops?: Partial<Record<CropMethodId, CropMethodOutcome>>;
}
