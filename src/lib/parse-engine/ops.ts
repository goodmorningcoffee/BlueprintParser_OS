/**
 * Correction ops (PLAN §1.3 E-2, §2.1). Pure and client-safe (E-8): the workspace previews every op
 * locally by re-applying the op list to the last parse result. WP-2.E lands the signature only; WP-3.D
 * fills the body (PLAN §1.6 rule 13). Until then it throws `ParseEngineNotImplementedError`.
 */

import { ParseEngineNotImplementedError, type CorrectionOp, type ParseResult, type StructureModel } from "./types";

/** Apply `ops` in order, by id, on top of the fused model in `base` (user corrections always win). */
export function applyOps(base: ParseResult, ops: readonly CorrectionOp[]): StructureModel {
  void base;
  void ops;
  throw new ParseEngineNotImplementedError("applyOps");
}
