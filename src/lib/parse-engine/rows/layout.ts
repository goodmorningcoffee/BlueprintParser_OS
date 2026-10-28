/**
 * rows/layout.ts — row candidates from compact Textract LAYOUT blocks (table pipeline WP-3.A; PLAN §1.4
 * `layout`, new in TP-3; stored by WP-2.E as `{k, b}` with no text).
 *
 * Blocks whose centre lies inside the box vote:
 * - `list` / `text` / `table`: a boundary at the block's top and bottom (paragraph starts);
 * - `section-header`: a section band (R5) and boundaries at its edges;
 * - `title`: when it sits in the top third of the box, its bottom is the header bottom.
 * No corpus page has stored LAYOUT (C2-m9), so this method is measurable only on uploads after TP-2; its
 * weight (.4) keeps it from deciding anything alone. A page without `layout` casts no vote (`error`). Pure.
 */

import { centreIn } from "../geometry";
import type { RowHypothesis, RowsInput } from "../types-rows";

export const LAYOUT_ROWS_VERSION = 1;
const LAYOUT_CONF = 0.5;

export function layoutRows(input: RowsInput): RowHypothesis {
  const base = { method: "layout" as const, methodVersion: LAYOUT_ROWS_VERSION };
  const blocks = (input.layout ?? []).filter((blk) => centreIn(blk.b, input.box));
  if (blocks.length === 0) return { ...base, conf: 0, error: input.layout ? "no LAYOUT block inside the box" : "page has no stored LAYOUT" };
  const box = input.box;
  const clamp = (y: number): number => Math.min(box[3], Math.max(box[1], y));
  const ys = new Set<number>();
  const sections: [number, number][] = [];
  let headerBottom: number | undefined;
  const topThird = box[1] + (box[3] - box[1]) / 3;
  for (const blk of [...blocks].sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0])) {
    ys.add(clamp(blk.b[1]));
    ys.add(clamp(blk.b[3]));
    if (blk.k === "section-header") sections.push([clamp(blk.b[1]), clamp(blk.b[3])]);
    if (blk.k === "title" && blk.b[3] <= topThird && (headerBottom === undefined || blk.b[3] > headerBottom)) headerBottom = clamp(blk.b[3]);
  }
  const rowLines = [...ys].sort((a, b) => a - b);
  if (rowLines.length < 2) return { ...base, conf: 0, error: "LAYOUT blocks give fewer than two boundaries" };
  return { ...base, conf: LAYOUT_CONF, rowLines, sections: sections.length ? sections : undefined, headerBottom };
}
