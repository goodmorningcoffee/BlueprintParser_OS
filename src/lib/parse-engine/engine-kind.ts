/**
 * The engine's kind head (table pipeline WP-3.D; PLAN §2.1 `ParseRequest.kind` "absent → kind heads on the box",
 * `ParseResult.kindSuggestion`). Pure, deterministic (E-7). Capability `kind` (ledger `kind.json`).
 *
 * Order (first that holds wins):
 * 1. the request's `kind` (the workspace sends the inbox item's kind) — no suggestion is returned;
 * 2. the owning classifier proposal (`hints.proposalId`, else the stored proposal over the box at IoU ≥ .5): its
 *    `classId` read by name — `keynote…` → keynote; `…legend…`, `symbol…`, `abbreviation…` → legend;
 *    `spec…`/`…specification…` → spec; `…note…` → notes; any other class → schedule. `p` = the proposal's p;
 * 3. the box itself: the paragraph segmenter's reading (`paragraphs/segment.ts`) — at least 3 keyed paragraphs
 *    holding ≥ 60 % of them, not a key–value list, and the table probe found ≤ 2 columns → notes / spec (as the
 *    segmenter names it), p .6; otherwise schedule, p .5.
 * The full classifier heads (45 schedule kinds, 8 notes kinds) on a `+ Region` box are the detect half's; this
 * head only decides which model family to build, so a wrong suggestion costs one `set-kind` and a re-parse.
 */

import type { BboxMinMax, EngineProposal, StructureKind, StructureParagraphDoc } from "./types";

export const KIND_HEAD_VERSION = 1;
export const KIND_PROPOSAL_IOU = 0.5;
export const KIND_MIN_KEYED = 3;
export const KIND_MIN_KEYED_SHARE = 0.6;

/** A classifier class id read as a structure kind (see the file header, rule 2). */
export function kindFromClassId(classId: string | null | undefined): StructureKind | null {
  if (typeof classId !== "string" || !classId.trim()) return null;
  const c = classId.toLowerCase();
  if (c.includes("keynote")) return "keynote";
  if (c.includes("legend") || c.startsWith("symbol") || c.includes("abbreviation")) return "legend";
  if (c.startsWith("spec") || c.includes("specification")) return "spec";
  if (c.includes("note")) return "notes";
  return "schedule";
}

const iou = (a: readonly number[], b: readonly number[]): number => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
};

/** The stored proposal this box parses: the hinted id, else the best IoU ≥ .5 (ties: first in page order). */
export function owningProposalOf(proposals: readonly EngineProposal[], bbox: BboxMinMax, proposalId?: string): EngineProposal | null {
  if (proposalId) {
    const hit = proposals.find((p) => p.id === proposalId);
    if (hit) return hit;
  }
  let best: EngineProposal | null = null;
  let bestIou = KIND_PROPOSAL_IOU;
  for (const p of proposals) {
    const v = iou(p.b, bbox);
    if (v >= bestIou && (best === null || v > bestIou)) { best = p; bestIou = v; }
  }
  return best;
}

export interface KindDecision {
  kind: StructureKind;
  classId: string | null;
  p: number;
  /** Where the kind came from. */
  src: "request" | "proposal" | "box";
}

/** Rule 3: the box read as paragraphs (`doc`) against the table probe's column count. */
export function kindFromBox(doc: Pick<StructureParagraphDoc, "kind" | "paragraphs" | "quality"> | null, tableCols: number): { kind: StructureKind; p: number } {
  if (doc && !doc.quality.flags.includes("kv-pairs")) {
    const keyed = doc.paragraphs.filter((p) => p.key !== null).length;
    if (keyed >= KIND_MIN_KEYED && keyed >= KIND_MIN_KEYED_SHARE * doc.paragraphs.length && tableCols <= 2) return { kind: doc.kind, p: 0.6 };
  }
  return { kind: "schedule", p: 0.5 };
}

/** The kind decision for a request (rules 1–2); `null` → the caller applies rule 3 with its probes. */
export function kindFromRequest(kind: StructureKind | undefined, proposal: EngineProposal | null): KindDecision | null {
  if (kind) return { kind, classId: proposal?.classId ?? null, p: 1, src: "request" };
  const k = kindFromClassId(proposal?.classId);
  if (proposal && k) return { kind: k, classId: proposal.classId, p: Math.max(0, Math.min(1, proposal.p)), src: "proposal" };
  return null;
}
