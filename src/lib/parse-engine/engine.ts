/**
 * The parse engine entry point (PLAN §1.5, §2.1). WP-2.E lands the SIGNATURE only, so TP-3's parallel
 * work packages build against a fixed contract; WP-3.D fills the body (PLAN §1.6 rule 13). Until
 * then every call throws `ParseEngineNotImplementedError`, so nothing can route through the engine
 * by accident (all tool flags default to `legacy`).
 */

import { ParseEngineNotImplementedError, type EnginePageEvidence, type ParseRequest, type ParseResult } from "./types";

/**
 * Parse one box of one page from the page's stored evidence. Deterministic (E-7): the same evidence and
 * request give a byte-equal result. Heavy evidence (crop rulings, a paid Textract crop, TATR) is
 * gathered by the server run service before this is called (rule 11), never inside a project write.
 */
export async function runParseEngine(evidence: EnginePageEvidence, request: ParseRequest): Promise<ParseResult> {
  void evidence;
  void request;
  throw new ParseEngineNotImplementedError("runParseEngine");
}
