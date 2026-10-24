// [evidence T4 2026-10-24] Public surface of the per-page evidence layer — see page-evidence.ts.
export * from "./types";
export {
  EVIDENCE_HOLE_CAP,
  EVIDENCE_TABLE_CAP,
  buildEvidenceSummary,
  getPageEvidence,
  isEvidenceSummary,
  isYoloTextDetection,
  sameEvidence,
  storedPageEvidence,
  summarizePageEvidence,
} from "./page-evidence";
export { fuseText, normaliseOcrConfidence, qYolo } from "./text-evidence";
export { buildEvidenceContextSection } from "./llm-context";
