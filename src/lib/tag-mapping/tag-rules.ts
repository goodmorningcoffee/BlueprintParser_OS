/**
 * tag-rules.ts — [tag-mapping v2 2026-10-24] The owner's text rules applied to free-floating
 * (Type 2) word hits, from the 2026-10-23/24 gold session (research/INPUT_gaussian_session):
 *
 *   rule 2  a 1–2-character tag counts only INSIDE A SHAPE or STANDING ALONE — never inside a
 *           sentence ("A" in "provide A solution");
 *   rule 3  dimensions are never tags (8'-0", 12");
 *   rule 4  keep full strings: "1" must not match the "1" that Textract split off "D-1";
 *   rule 1  a detail callout ("3 over R-3") is a detail title, never tag "3".
 *
 * `verdictForWordHit` returns why a hit is rejected (or "ok"); the matcher drops rejected hits
 * before scoring, so v1's `dropCounts` keys (a frozen 5-key object) are untouched. The legacy
 * shim passes no rules and keeps v1's verbatim behaviour.
 */

import type { TextractWord } from "@/types";
import { bboxCenterLTWH, bboxContainsPoint } from "@/lib/bbox-utils";
import { isShortTag, looksLikeDimension, type EnsembleShape } from "@/lib/shape-ensemble";

export interface TagRulesOptions {
  /** rule 2 */
  shortTagNeedsShapeOrAlone: boolean;
  /** rule 3 */
  rejectDimensions: boolean;
  /** rule 4: a word glued to a neighbour (gap ≤ `glueGap` × height) is part of a larger token. */
  tokenBoundary: boolean;
  /** Gap, in word heights, under which two words on a line are one token (Textract hyphen splits). */
  glueGap: number;
  /** Gap, in word heights, within which a neighbour makes a short tag part of a sentence. */
  aloneGap: number;
  /** Type 3 fallback: a floating word binds to a tag shape only within this many shape long-sides
   *  (matchers/ensemble-shapes.ts FLOATING_BIND_REACH). null = v1 semantics, any distance. */
  floatingBindReach: number | null;
}

export const DEFAULT_TAG_RULES: TagRulesOptions = {
  shortTagNeedsShapeOrAlone: true,
  rejectDimensions: true,
  tokenBoundary: true,
  glueGap: 0.3,
  aloneGap: 1.5,
  floatingBindReach: null,
};

export type TagRuleVerdict = "ok" | "dimension" | "partial_token" | "in_sentence" | "detail_callout";

export interface WordHitContext {
  rules: TagRulesOptions;
  /** Ensemble shapes on the hit's page (any kind); absent → no shape is known. */
  shapes?: readonly EnsembleShape[];
  /** True when the tag being searched is itself a project sheet number (callouts then ARE hits). */
  tagIsSheetNumber?: boolean;
}

const sameLine = (a: TextractWord, b: TextractWord): boolean => {
  const ay = a.bbox[1] + a.bbox[3] / 2;
  const by = b.bbox[1] + b.bbox[3] / 2;
  return Math.abs(ay - by) < ((a.bbox[3] + b.bbox[3]) / 2) * 0.5;
};

/** Horizontal gap between two words on a line, in heights of the first (negative = overlapping). */
function gapInHeights(w: TextractWord, other: TextractWord): number {
  const h = w.bbox[3] || 1e-6;
  const [l, , width] = w.bbox;
  const r = l + width;
  const ol = other.bbox[0];
  const or = other.bbox[0] + other.bbox[2];
  const gap = ol >= r ? ol - r : or <= l ? l - or : -1;
  return gap / h;
}

/** The shape (if any) whose bbox holds the centre of the hit's first and last word. */
export function enclosingShape(words: readonly TextractWord[], shapes: readonly EnsembleShape[] | undefined): EnsembleShape | null {
  if (!shapes || shapes.length === 0 || words.length === 0) return null;
  const first = bboxCenterLTWH(words[0].bbox);
  const last = bboxCenterLTWH(words[words.length - 1].bbox);
  for (const s of shapes) {
    if (bboxContainsPoint(s.bbox, first) && bboxContainsPoint(s.bbox, last)) return s;
  }
  return null;
}

/**
 * Apply the rules to a hit made of `hitWords` (one word, or the adjacent window of a multi-word
 * tag) among `pageWords`. `normalizedTag` is the tag being searched.
 */
export function verdictForWordHit(
  hitWords: readonly TextractWord[],
  pageWords: readonly TextractWord[],
  normalizedTag: string,
  ctx: WordHitContext,
): TagRuleVerdict {
  const { rules } = ctx;
  if (hitWords.length === 0) return "ok";
  const hitText = hitWords.map((w) => w.text).join(" ");
  if (rules.rejectDimensions && looksLikeDimension(hitText)) return "dimension";

  const shape = enclosingShape(hitWords, ctx.shapes);
  if (shape?.kind === "detail_callout" && !ctx.tagIsSheetNumber) return "detail_callout";
  if (shape) return "ok"; // inside a tag shape: rules 2 and 4 are satisfied by the bubble itself

  const first = hitWords[0];
  const last = hitWords[hitWords.length - 1];
  const hitSet = new Set(hitWords);
  let nearestLeft = Infinity;
  let nearestRight = Infinity;
  let gluedNeighbourIsDimension = false;
  for (const w of pageWords) {
    if (hitSet.has(w)) continue;
    if (!sameLine(w, first) && !sameLine(w, last)) continue;
    const isLeft = w.bbox[0] + w.bbox[2] <= first.bbox[0] + first.bbox[2] * 0.5;
    const gap = isLeft ? gapInHeights(first, w) : gapInHeights(last, w);
    if (gap < 0) continue; // vertical overlap only (a word from another column)
    if (isLeft) nearestLeft = Math.min(nearestLeft, gap);
    else nearestRight = Math.min(nearestRight, gap);
    if (gap <= rules.glueGap && /^['"”″′]/.test(w.text)) gluedNeighbourIsDimension = true;
  }
  if (rules.rejectDimensions && gluedNeighbourIsDimension) return "dimension";
  if (rules.tokenBoundary && (nearestLeft <= rules.glueGap || nearestRight <= rules.glueGap)) return "partial_token";
  if (rules.shortTagNeedsShapeOrAlone && isShortTag(normalizedTag)
      && (nearestLeft <= rules.aloneGap || nearestRight <= rules.aloneGap)) return "in_sentence";
  return "ok";
}
