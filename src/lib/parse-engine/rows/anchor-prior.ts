/**
 * rows/anchor-prior.ts — stored proposal anchors as a PRIOR, never a vote (table pipeline WP-3.A; PLAN §1.4
 * R6; the first reader of a stored `classifierProposals[].tagMap`).
 *
 * The proposal that owns the box (`hints.proposalId`, else the stored proposal with the best IoU ≥ .5 with
 * the box) carries one `tagMap.rows[]` entry per tag shape it saw at proposal time. Those anchors come from
 * the same shapes the live `shape-centres` method reads, so they never vote. For a row whose live shape is
 * missing (hidden, deleted, below detector confidence) the anchor's **shape-bbox centre** is inserted as a
 * centre. Its stored `rowBbox` is NEVER read: before TP-2.C it was a top-of-shape band, so it is stale on
 * every proposal stored before that release (R6).
 *
 * An anchor with a live fused shape at IoU ≥ .5 is dropped; so is one whose centre lies outside the box.
 * Pure (E-7).
 */

import { iou } from "@/lib/region-classifier-v2/geometry";
import { centreIn } from "../geometry";
import type { BboxMinMax, EngineProposal } from "../types";
import type { FusedShape, RowsInput } from "../types-rows";

export const ANCHOR_LIVE_IOU = 0.5;

export interface AnchorCentre {
  /** The anchor's shape box (its centre is the row centre). */
  b: BboxMinMax;
  tag: string | null;
  shapeClass: string;
  proposalId: string;
}

/** The proposal that owns the box: the hinted id, else the best IoU ≥ .5 (ties: the earlier proposal). */
export function owningProposal(input: RowsInput): EngineProposal | null {
  const hinted = input.hints?.proposalId;
  if (hinted) {
    const p = input.proposals.find((q) => q.id === hinted);
    if (p) return p;
  }
  let best: EngineProposal | null = null;
  let bestIou = ANCHOR_LIVE_IOU;
  for (const p of input.proposals) {
    const v = iou(p.b, input.box);
    if (v > bestIou || (best === null && v >= bestIou)) { best = p; bestIou = v; }
  }
  return best;
}

/**
 * R6: the anchor centres to insert — the owning proposal's tag-map rows whose shape has no live fused shape at
 * IoU ≥ .5 and whose centre lies inside the box, top to bottom.
 */
export function anchorCentres(input: RowsInput, live: readonly FusedShape[]): AnchorCentre[] {
  const p = owningProposal(input);
  const rows = p?.tagMap?.rows;
  if (!p || !rows || rows.length === 0) return [];
  const out: AnchorCentre[] = [];
  for (const r of rows) {
    if (!centreIn(r.shapeBbox, input.box)) continue;
    if (live.some((s) => iou(s.b, r.shapeBbox) >= ANCHOR_LIVE_IOU)) continue;
    if (out.some((o) => iou(o.b, r.shapeBbox) >= ANCHOR_LIVE_IOU)) continue; // a duplicated anchor
    out.push({ b: r.shapeBbox, tag: r.tag, shapeClass: r.shapeClass, proposalId: p.id });
  }
  return out.sort((a, b) => (a.b[1] + a.b[3]) - (b.b[1] + b.b[3]) || a.b[0] - b.b[0]);
}
